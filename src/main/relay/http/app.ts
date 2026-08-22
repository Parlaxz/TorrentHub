import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { AuthController } from "../../auth/controller.js";
import type { JobService } from "../jobService.js";
import type { RelaySnapshot } from "../lifecycle.js";
import { ServiceError } from "./errors.js";
import { registerRoutes } from "./routes.js";

declare module "fastify" {
  interface FastifyRequest {
    client?: import("../../auth/tokenStore.js").ClientMeta;
  }
}

export interface RelayAppDeps {
  auth: AuthController;
  jobs: JobService;
  transportSnapshot?: () => RelaySnapshot | null;
  serverVersion?: string;
  bodyLimit?: number;
  logger?: FastifyServerOptions["logger"];
  /** "Friend mode" queue: jobs the server user sent to paired clients. */
  directJobs?: {
    queuedFor(clientId: string): Promise<
      Array<{ id: string; source: string; sourceKind: string; state: string }>
    >;
    setState(id: string, state: "accepted" | "declined"): Promise<unknown>;
  } | null;
}

export const DEFAULT_BODY_LIMIT_BYTES = 128 * 1024;

function withRedaction(logger: FastifyServerOptions["logger"]): FastifyServerOptions["logger"] {
  const redact = {
    paths: ["req.headers.authorization", "req.headers.cookie"],
    censor: "[REDACTED]",
  };
  const serializers = {
    req: (req: { method?: string; url?: string; headers?: unknown }) => ({
      method: req.method,
      url: req.url,
      headers: req.headers,
    }),
  };
  if (logger === undefined || typeof logger === "boolean") {
    return { level: logger === false ? "silent" : "info", redact, serializers };
  }
  const merged = { ...(logger as Record<string, unknown>), redact } as Record<string, unknown>;
  if (merged.serializers === undefined) merged.serializers = serializers;
  return merged as FastifyServerOptions["logger"];
}

export function buildRelayServer(deps: RelayAppDeps): FastifyInstance {
  const app = Fastify({
    bodyLimit: deps.bodyLimit ?? DEFAULT_BODY_LIMIT_BYTES,
    logger: withRedaction(deps.logger),
    trustProxy: false,
    genReqId: () => randomUUID(),
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ServiceError) {
      reply.code(err.statusCode).send({ error: err.code, message: err.message });
      return;
    }
    if (err.name === "ZodError") {
      reply.code(400).send({ error: "validation_error", message: "invalid request" });
      return;
    }
    const statusCode =
      typeof err.statusCode === "number" && err.statusCode >= 400 ? err.statusCode : 500;
    if (statusCode >= 500) {
      req.log.error({ err }, "request_failed");
      reply.code(statusCode).send({ error: "internal_error" });
      return;
    }
    req.log.warn({ err, statusCode }, "request_rejected");
    const code =
      statusCode === 413
        ? "payload_too_large"
        : statusCode === 429
          ? "rate_limited"
          : "bad_request";
    reply.code(statusCode).send({ error: code, message: String(err.message ?? code) });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: "not_found" });
  });

  registerRoutes(app, deps);
  return app;
}
