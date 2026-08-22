import type { FastifyInstance, FastifyRequest } from "fastify";
import { jobNotFound } from "../jobService.js";
import type { RelayAppDeps } from "./app.js";
import { ServiceError } from "./errors.js";
import {
  formatIssues,
  historyQuerySchema,
  idParamSchema,
  intakeCreateSchema,
  jobCreateSchema,
  pairRequestSchema,
} from "./schemas.js";

const BEARER_RE = /^Bearer\s+(.+)$/i;

function requireId(req: FastifyRequest): string {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    throw new ServiceError(400, "validation_error", "invalid id parameter");
  }
  return parsed.data.id;
}

function resolveIdempotencyKey(
  req: FastifyRequest,
  bodyKey: string | null | undefined,
): string | null {
  const headerKey = req.headers["idempotency-key"];
  if (typeof headerKey === "string" && headerKey.trim().length > 0) {
    return headerKey.trim().slice(0, 128);
  }
  return bodyKey ?? null;
}

export function registerRoutes(app: FastifyInstance, deps: RelayAppDeps): void {
  const { auth, jobs } = deps;

  app.get("/v1/health", async () => ({ ok: true }));

  app.post("/v1/pair", async (req, reply) => {
    const parsed = pairRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_error", issues: formatIssues(parsed.error) });
    }
    const result = auth.pairAttempt(parsed.data.code, req.ip || "unknown", parsed.data.name);
    if (!result.ok) {
      if (result.retryAfterMs !== undefined) {
        reply.header("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
      }
      return reply.code(result.status).send({
        error: result.error,
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
      });
    }
    return reply.code(200).send({
      clientId: result.issued.clientId,
      name: result.issued.name,
      token: result.issued.token,
    });
  });

  app.register(
    async function authenticatedApi(api) {
    api.addHook("preHandler", async (req, reply) => {
      const header = req.headers.authorization;
      const match = typeof header === "string" ? BEARER_RE.exec(header) : null;
      const token = match?.[1]?.trim() ?? "";
      const client = token.length > 0 ? auth.authenticate(token) : null;
      if (!client) {
        reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "unauthorized" });
        return;
      }
      req.client = client;
    });

    api.post("/intakes", async (req, reply) => {
      const parsed = intakeCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "validation_error", issues: formatIssues(parsed.error) });
      }
      const view = await jobs.createIntake({
        source: parsed.data.source,
        idempotencyKey: resolveIdempotencyKey(req, parsed.data.idempotencyKey ?? null),
      });
      return reply.code(201).send(view);
    });

    api.get("/intakes/:id", async (req) => {
      const id = requireId(req);
      const view = await jobs.getIntake(id);
      if (!view) throw jobNotFound(id);
      return view;
    });

    api.post("/jobs", async (req, reply) => {
      const parsed = jobCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "validation_error", issues: formatIssues(parsed.error) });
      }
      const record = await jobs.createJob({
        intakeId: parsed.data.intakeId,
        selection: parsed.data.selection ?? null,
        zipRequired: parsed.data.zipRequired ?? null,
        idempotencyKey: resolveIdempotencyKey(req, parsed.data.idempotencyKey ?? null),
      });
      return reply.code(201).send(record);
    });

    api.get("/jobs", async () => ({ jobs: await jobs.listJobs() }));

    api.get("/jobs/:id", async (req) => {
      const id = requireId(req);
      const record = await jobs.getJob(id);
      if (!record) throw jobNotFound(id);
      return record;
    });

    api.post("/jobs/:id/cancel", async (req) => jobs.cancelJob(requireId(req)));
    api.post("/jobs/:id/retry-packaging", async (req) => jobs.retryPackaging(requireId(req)));
    api.post("/jobs/:id/retry-upload", async (req) => jobs.retryUpload(requireId(req)));
    api.post("/jobs/:id/recheck-storage", async (req) => jobs.recheckStorage(requireId(req)));

    api.get("/history", async (req) => {
      const parsed = historyQuerySchema.safeParse((req.query as Record<string, unknown>) ?? {});
      if (!parsed.success) {
        throw new ServiceError(400, "validation_error", "invalid history query");
      }
      return { history: await jobs.listHistory(parsed.data.limit) };
    });

    api.get("/server/status", async () => ({
      ok: true,
      server: { name: "viking-relay", version: deps.serverVersion ?? "0.1.0" },
      transport: deps.transportSnapshot?.() ?? null,
      pairedClients: auth.listClients().filter((c) => !c.revoked).length,
      time: new Date().toISOString(),
    }));
  }, { prefix: "/v1" });
}
