/**
 * Server Mode composition root.
 *
 * Builds the full service graph from persisted settings + safeStorage
 * secrets. The JOB ENGINE and its gateways are created ONCE per process
 * (lazy); only the relay transport is rebuilt per Start/Stop so port and
 * adapter changes apply without touching in-flight pipeline state.
 *
 * startupSweep() runs exactly once per process before jobs are exposed:
 * nonterminal previous-session jobs are marked interrupted — no qBit
 * reconstruction, no ZIP resume, no Viking multipart resume.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Logger } from 'pino';
import { AuthController } from '../auth';
import { TokenStore } from '../auth/tokenStore';
import { JobEngine } from '../jobs';
import { JsonJobRepository, FsWorkspaceGateway, resolveConfig } from '../jobs';
import type { JobRepository } from '../jobs/gateways';
import { QbitTorrentService } from '../qbit';
import { VikingClient } from '../viking';
import { createRelayManager } from '../relay';
import type { RelayManager } from '../relay/lifecycle';
import type { AppSettingsStore } from '../settings-store';
import type { SecretStore } from '../secrets';
import { EngineJobService } from '../integration/job-service';
import { PackagingGatewayAdapter } from '../integration/packaging-gateway';
import { QbitTorrentGateway } from '../integration/qbit-gateway';
import { StoragePolicyGateway } from '../integration/storage-gateway';
import { HttpDirectDownloadGateway } from '../integration/direct-gateway';
import { VikingGatewayAdapter } from '../integration/viking-gateway';
import { SafeStorageTokenPersistence } from './auth-persistence';
import { resolveDirectLinkViaWindow } from '../viking/direct-link-window';

export const SECRET_QBIT_API_KEY = 'qbittorrent.apiKey';
export const SECRET_VIKING_USER_HASH = 'viking.userHash';

export interface CompositionHost {
  settings: AppSettingsStore;
  secrets: SecretStore;
  log: Logger;
  /** userData root for small state (history JSON). */
  userDataDir: string;
}

export interface ServerComposition {
  qbit: QbitTorrentService;
  viking: VikingClient;
  engine: JobEngine;
  jobService: EngineJobService;
  auth: AuthController;
  relay: RelayManager;
  jobsRoot: string;
}

export interface EngineGraph {
  engine: JobEngine;
  jobService: EngineJobService;
  auth: AuthController;
  repository: JobRepository;
}

export function buildQbitService(host: CompositionHost): QbitTorrentService {
  const settings = host.settings.get();
  const apiKey = host.secrets.get(SECRET_QBIT_API_KEY) ?? undefined;
  return new QbitTorrentService({
    baseUrl: settings.qbittorrentBaseUrl,
    apiKey,
  });
}

export function buildVikingClient(host: CompositionHost): VikingClient {
  const userHash = host.secrets.get(SECRET_VIKING_USER_HASH);
  return new VikingClient({
    userHash: userHash ?? undefined,
    logger: {
      debug: (m, meta) => host.log.debug({ m, meta }, 'viking'),
      info: (m, meta) => host.log.info({ m, meta }, 'viking'),
      warn: (m, meta) => host.log.warn({ m, meta }, 'viking'),
      error: (m, meta) => host.log.error({ m, meta }, 'viking'),
    },
  });
}

export function resolveJobsRoot(host: CompositionHost): string {
  const settings = host.settings.get();
  return join(settings.dataDir ?? join(host.userDataDir, 'data'), 'jobs');
}

/** Creates the long-lived engine graph. Called once per process. */
export function buildEngineGraph(
  host: CompositionHost,
  resolveQbit: () => QbitTorrentService,
  resolveViking: () => VikingClient,
): EngineGraph {
  const persistence = new SafeStorageTokenPersistence(host.secrets);
  const secret = persistence.ensureSecret();
  const tokens = new TokenStore(persistence, secret);
  const auth = new AuthController({ tokens });

  // The jobs root must exist before the first preflight: statfs on a missing
  // path fails, which used to surface client-side as "Blocked — need 0 GB".
  mkdirSync(resolveJobsRoot(host), { recursive: true });

  const torrent = new QbitTorrentGateway(resolveQbit);
  const direct = new HttpDirectDownloadGateway();
  const viking = new VikingGatewayAdapter(resolveViking, (pageUrl) =>
    resolveDirectLinkViaWindow(pageUrl, host.log),
  );
  const packaging = new PackagingGatewayAdapter();
  const storage = new StoragePolicyGateway({
    warn: (obj, msg) => host.log.warn(obj, msg),
  });
  const workspace = new FsWorkspaceGateway(resolveJobsRoot(host));
  const repository = new JsonJobRepository({
    filePath: join(host.userDataDir, 'data', 'job-history.json'),
  });

  const engine = new JobEngine(
    { torrent, direct, viking, packaging, storage, workspace, repository },
    resolveConfig({
      jobsRoot: resolveJobsRoot(host),
      historyFilePath: join(host.userDataDir, 'data', 'job-history.json'),
      cleanupDefaults: {
        deleteTorrent: host.settings.get().cleanupDeleteTorrent,
        deleteFiles: host.settings.get().cleanupDeleteFiles,
        deleteZip: host.settings.get().cleanupDeleteZip,
      },
      logger: {
        info: (obj, msg) => host.log.info(obj, msg),
        warn: (obj, msg) => host.log.warn(obj, msg),
      },
    }),
  );
  return { engine, jobService: new EngineJobService(engine), auth, repository };
}

/** Builds a fresh relay transport around the stable engine graph. */
export function buildRelay(
  host: CompositionHost,
  jobService: EngineJobService,
  auth: AuthController,
  directJobs?: {
    add(
      source: string,
      sourceKind: string,
      targetClientId: string,
      targetName: string,
      from?: { clientId: string; name: string },
    ): Promise<{ id: string }>;
    queuedFor(clientId: string): Promise<
        Array<{ id: string; source: string; sourceKind: string; state: string; fromName?: string }>
      >;
    setState(id: string, state: 'accepted' | 'declined'): Promise<unknown>;
  } | null,
): RelayManager {
  const settings = host.settings.get();
  return createRelayManager({
    auth,
    jobs: jobService,
    port: settings.serverPort,
    pollIntervalMs: 5000,
    directJobs: directJobs ?? null,
    selection: {
      overrideAddress: settings.radminInterfaceId ?? null,
      preferredAdapterNames: [],
    },
    logger: {
      info: (...args: unknown[]) => host.log.info(...(args as [string])),
      warn: (...args: unknown[]) => host.log.warn(...(args as [string])),
      error: (...args: unknown[]) => host.log.error(...(args as [string])),
    },
  });
}

