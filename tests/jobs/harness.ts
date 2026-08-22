/** Test harness wiring JobEngine with fake gateways + event ordering log. */
import { JobEngine, resolveConfig } from "../../src/main/jobs/index.ts";
import type {
  DirectDownloadGateway,
  JobRepository,
  StorageGateway,
  TorrentGateway,
  VikingGateway,
  WorkspaceGateway,
} from "../../src/main/jobs/index.ts";
import {
  FakeDirectDownloadGateway,
  FakePackagingGateway,
  FakeStorageGateway,
  FakeTorrentGateway,
  FakeVikingGateway,
  FakeWorkspaceGateway,
  MemoryJobRepository,
  fakeMetadata,
  type PackageBehavior,
  type TelemetrySample,
  type UploadBehavior,
} from "./fakes.ts";

export interface Harness {
  engine: JobEngine;
  repo: MemoryJobRepository;
  torrent: FakeTorrentGateway;
  viking: FakeVikingGateway;
  packaging: FakePackagingGateway;
  storage: FakeStorageGateway;
  workspace: FakeWorkspaceGateway;
  /** Ordered event log for persistence/cleanup ordering assertions. */
  events: string[];
}

export interface HarnessOptions {
  metadata?: ReturnType<typeof fakeMetadata>;
  telemetryScript?: TelemetrySample[];
  storageFreeReadings?: number[];
  vikingBehaviors?: UploadBehavior[];
  packagingBehaviors?: PackageBehavior[];
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  const repo = new MemoryJobRepository();

  const torrent = new FakeTorrentGateway(
    options.metadata ?? fakeMetadata(2),
    options.telemetryScript ?? [
      { downloadedBytes: 0, selectedComplete: false, speedBps: 0, seeds: 0, peers: 0 },
      { downloadedBytes: 2000, selectedComplete: true, speedBps: 50_000, seeds: 3, peers: 5 },
    ],
  );
  const viking = options.vikingBehaviors
    ? new FakeVikingGateway(options.vikingBehaviors)
    : new FakeVikingGateway();
  const packaging = options.packagingBehaviors
    ? new FakePackagingGateway(options.packagingBehaviors)
    : new FakePackagingGateway();
  const storage = new FakeStorageGateway(options.storageFreeReadings ?? [1_000_000_000]);
  const workspace = new FakeWorkspaceGateway();

  const trackedRepo: JobRepository = {
    loadAll: () => repo.loadAll(),
    get: (id) => repo.get(id),
    findByIdempotencyKey: (key) => repo.findByIdempotencyKey(key),
    upsert: async (record) => {
      await repo.upsert(record);
      events.push(record.result?.url ? `save:${record.state}:url` : `save:${record.state}`);
    },
  };

  const trackedTorrent: TorrentGateway = {
    fetchMetadata: (source) => torrent.fetchMetadata(source),
    addTorrent: (source, opts) => torrent.addTorrent(source, opts),
    getProgress: (handle) => torrent.getProgress(handle),
    stop: (handle) => torrent.stop(handle),
    deleteOwned: async (handle, deleteData) => {
      await torrent.deleteOwned(handle, deleteData);
      events.push(`delete-owned:${deleteData}`);
    },
  };

  const trackedWorkspace: WorkspaceGateway = {
    createJobDirs: (jobId) => workspace.createJobDirs(jobId),
    removePath: async (target) => {
      await workspace.removePath(target);
      events.push(`remove:${target}`);
    },
    join: (...parts) => workspace.join(...parts),
    pathExists: (target) => workspace.pathExists(target),
    joinDownload: (downloadDir, filename) => workspace.joinDownload(downloadDir, filename),
    statFile: (target) => workspace.statFile(target),
  };

  const direct: DirectDownloadGateway = new FakeDirectDownloadGateway();

  const engine = new JobEngine(
    {
      torrent: trackedTorrent,
      direct,
      viking: viking as VikingGateway,
      packaging: packaging,
      storage: storage as StorageGateway,
      workspace: trackedWorkspace,
      repository: trackedRepo,
    },
    resolveConfig({
      jobsRoot: "/data",
      historyFilePath: "/data/history.json",
      pollIntervalMs: 1,
      zeroSpeedMs: 30_000,
      slowSpeedBps: 1,
      slowSpeedMs: 30_000,
      safetyReserveBytes: 1000,
      lowHeadroomBytes: 500,
      historyLimit: 100,
    }),
  );

  return { engine, repo, torrent, viking, packaging, storage, workspace, events };
}

/** Poll until fn returns a truthy value or timeout. */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 3000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
