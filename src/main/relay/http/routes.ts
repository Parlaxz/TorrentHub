import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
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
        clientId: req.client!.clientId,
      });
      return reply.code(201).send(view);
    });

    api.get("/intakes/:id", async (req) => {
      const id = requireId(req);
      const view = await jobs.getIntake(id, req.client!.clientId);
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
        cleanup: parsed.data.cleanup ?? null,
        clientId: req.client!.clientId,
      });
      return reply.code(201).send(record);
    });

    api.get("/jobs", async (req) => ({ jobs: await jobs.listJobs(req.client!.clientId) }));

    api.get("/jobs/:id", async (req) => {
      const id = requireId(req);
      const record = await jobs.getJob(id, req.client!.clientId);
      if (!record) throw jobNotFound(id);
      return record;
    });

    api.post("/jobs/:id/cancel", async (req) => jobs.cancelJob(requireId(req), req.client!.clientId));
    api.post("/jobs/:id/retry-packaging", async (req) => jobs.retryPackaging(requireId(req), req.client!.clientId));
    api.post("/jobs/:id/retry-upload", async (req) => jobs.retryUpload(requireId(req), req.client!.clientId));
    api.post("/jobs/:id/recheck-storage", async (req) => jobs.recheckStorage(requireId(req), req.client!.clientId));

    api.get("/history", async (req) => {
      const parsed = historyQuerySchema.safeParse((req.query as Record<string, unknown>) ?? {});
      if (!parsed.success) {
        throw new ServiceError(400, "validation_error", "invalid history query");
      }
      return { history: await jobs.listHistory(parsed.data.limit, req.client!.clientId) };
    });

    api.get("/server/status", async () => ({
      ok: true,
      server: { name: "viking-relay", version: deps.serverVersion ?? "0.1.0" },
      transport: deps.transportSnapshot?.() ?? null,
      pairedClients: auth.listClients().filter((c) => !c.revoked).length,
      time: new Date().toISOString(),
    }));

    // ---- direct downloads ("friend mode") ----

    /** Roster of OTHER paired clients, for client-to-client sends. */
    api.get("/clients", async (req) => {
      const self = req.client!.clientId;
      const clients = auth
        .listClients()
        .filter((c) => !c.revoked && c.clientId !== self)
        .map((c) => ({ clientId: c.clientId, name: c.name }));
      return { clients };
    });

    /** A paired client sends a link to another paired client. */
    api.post("/direct-jobs", async (req, reply) => {
      if (!deps.directJobs) {
        return reply.code(503).send({ error: "unavailable", message: "direct jobs disabled" });
      }
      const parsed = z
        .strictObject({
          source: z.string().min(8).max(4096),
          targetClientId: z.string().min(1).max(64),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "validation_error", issues: formatIssues(parsed.error) });
      }
      const from = req.client!;
      if (parsed.data.targetClientId === from.clientId) {
        return reply.code(400).send({ error: "validation_error", message: "cannot target yourself" });
      }
      const target = auth
        .listClients()
        .find((c) => !c.revoked && c.clientId === parsed.data.targetClientId);
      if (!target) {
        return reply.code(404).send({ error: "not_found", message: "target client is not paired" });
      }
      const kind = parsed.data.source.startsWith("magnet:")
        ? "magnet"
        : /^https?:\/\//i.test(parsed.data.source)
          ? "url"
          : null;
      if (!kind) {
        return reply.code(400).send({ error: "validation_error", message: "source must be a magnet or http(s) link" });
      }
      const job = await deps.directJobs.add(
        parsed.data.source,
        kind,
        target.clientId,
        target.name,
        { clientId: from.clientId, name: from.name },
      );
      return reply.code(201).send({ id: job.id });
    });

    api.get("/direct-jobs", async (req) => {
      if (!deps.directJobs) return { jobs: [] };
      return { jobs: await deps.directJobs.queuedFor(req.client!.clientId) };
    });

    api.post("/direct-jobs/:id/accept", async (req) => {
      const id = requireId(req);
      const job = await deps.directJobs?.setState(id, "accepted");
      if (!job) throw new ServiceError(404, "not_found", `no queued direct job ${id}`);
      return { ok: true };
    });

    api.post("/direct-jobs/:id/decline", async (req) => {
      const id = requireId(req);
      const job = await deps.directJobs?.setState(id, "declined");
      if (!job) throw new ServiceError(404, "not_found", `no queued direct job ${id}`);
      return { ok: true };
    });
  }, { prefix: "/v1" });
}
