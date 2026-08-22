export * from "./adapters.js";
export * from "./lifecycle.js";
export * from "./jobService.js";
export {
  buildRelayServer,
  DEFAULT_BODY_LIMIT_BYTES,
  type RelayAppDeps,
} from "./http/app.js";
export { AuthController } from "../auth/index.js";
export type { ClientMeta } from "../auth/tokenStore.js";

import { buildRelayServer } from "./http/app.js";
import { AuthController } from "../auth/index.js";
import { RelayManager, type RelayManagerOptions } from "./lifecycle.js";
import type { JobService } from "./jobService.js";

export interface CreateRelayManagerOptions extends Omit<RelayManagerOptions, "buildApp"> {
  auth?: AuthController;
  jobs: JobService;
  serverVersion?: string;
  directJobs?: {
    queuedFor(clientId: string): Promise<
      Array<{ id: string; source: string; sourceKind: string; state: string }>
    >;
    setState(id: string, state: "accepted" | "declined"): Promise<unknown>;
  } | null;
}

export function createRelayManager(options: CreateRelayManagerOptions): RelayManager {
  const { auth, jobs, serverVersion, directJobs, ...rest } = options;
  let manager: RelayManager | null = null;
  manager = new RelayManager({
    ...rest,
    buildApp: () =>
      buildRelayServer({
        auth: auth ?? new AuthController(),
        jobs,
        serverVersion,
        directJobs: directJobs ?? null,
        transportSnapshot: () => (manager !== null ? manager.snapshot() : null),
      }),
  });
  return manager;
}
