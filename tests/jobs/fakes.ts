/**
 * Fake gateways for A5 job engine tests. No real I/O.
 */
import type {
  AddTorrentOptions,
  JobRepository,
  PackagingGateway,
  StorageGateway,
  TorrentGateway,
  TorrentHandle,
  UploadRequest,
  VikingGateway,
  VikingUploadResult,
  WorkspaceGateway,
  ZipRequest,
} from "../../src/main/jobs/index.ts";
import type {
  DownloadTelemetry,
  IntakeSource,
  JobRecord,
  TorrentMetadataInfo,
} from "../../src/main/jobs/index.ts";

export function fakeMetadata(fileCount: number, sizePerFile = 1000): TorrentMetadataInfo {
  const files = Array.from({ length: fileCount }, (_, i) => ({
    index: i,
    path: `folder/file${i}.bin`,
    sizeBytes: sizePerFile,
  }));
  return {
    name: "My Torrent",
    infoHashV1: "hashv1",
    files,
    totalSizeBytes: fileCount * sizePerFile,
  };
}

export interface TelemetrySample {
  downloadedBytes: number;
  totalSelectedBytes?: number;
  speedBps?: number;
  etaSeconds?: number | null;
  seeds?: number;
  peers?: number;
  selectedComplete?: boolean;
}

export class FakeTorrentGateway implements TorrentGateway {
  metadata: TorrentMetadataInfo;
  /** Samples returned in order; the last one repeats forever. */
  script: TelemetrySample[];
  fetchMetadataError: Error | null = null;
  deleteOwnedShouldThrow: Error | null = null;

  fetchMetadataCount = 0;
  readonly addTorrentCalls: Array<{ source: IntakeSource; options: AddTorrentOptions }> = [];
  stopCount = 0;
  readonly deleteOwnedCalls: Array<{ handle: TorrentHandle; deleteData: boolean }> = [];
  #nextTorrentId = 1;

  constructor(metadata: TorrentMetadataInfo, script: TelemetrySample[]) {
    this.metadata = metadata;
    this.script = script;
  }

  async fetchMetadata(_source: IntakeSource): Promise<TorrentMetadataInfo> {
    this.fetchMetadataCount += 1;
    if (this.fetchMetadataError) throw this.fetchMetadataError;
    return this.metadata;
  }

  async addTorrent(source: IntakeSource, options: AddTorrentOptions): Promise<TorrentHandle> {
    this.addTorrentCalls.push({ source, options });
    return { torrentId: `torrent-${this.#nextTorrentId++}` };
  }

  async getProgress(handle: TorrentHandle): Promise<DownloadTelemetry> {
    void handle;
    if (this.script.length === 0) throw new Error("empty telemetry script");
    const sample = this.script.shift() ?? this.script[this.script.length - 1];
    // Re-push the last sample so it repeats forever once reached.
    if (this.script.length === 0) this.script.push(sample);
    const added = this.addTorrentCalls.at(-1);
    const selectedFiles =
      sample.selectedComplete && added
        ? added.options.selectedIndexes.map((index) => ({
            index,
            absolutePath: joinPosix(added.options.outputDir, this.metadata.files[index].path),
          }))
        : null;
    return {
      progressPct:
        sample.totalSelectedBytes !== undefined
          ? Math.min(100, (sample.downloadedBytes / sample.totalSelectedBytes) * 100)
          : sample.selectedComplete
            ? 100
            : 0,
      downloadedBytes: sample.downloadedBytes,
      totalSelectedBytes: sample.totalSelectedBytes ?? 0,
      speedBps: sample.speedBps ?? 0,
      etaSeconds: sample.etaSeconds ?? null,
      seeds: sample.seeds ?? 0,
      peers: sample.peers ?? 0,
      selectedComplete: sample.selectedComplete ?? false,
      selectedFiles,
    };
  }

  async stop(_handle: TorrentHandle): Promise<void> {
    this.stopCount += 1;
  }

  async deleteOwned(handle: TorrentHandle, deleteData: boolean): Promise<void> {
    this.deleteOwnedCalls.push({ handle, deleteData });
    if (this.deleteOwnedShouldThrow) throw this.deleteOwnedShouldThrow;
  }
}

export type UploadBehavior = VikingUploadResult | Error;

export type PackageBehavior =
  | { sizeBytes: number }
  | Error
  | { hangUntil: (signal: AbortSignal) => Promise<{ zipPath: string; sizeBytes: number }> };

export class FakeVikingGateway implements VikingGateway {
  /** Behaviors consumed per upload call; last one repeats. */
  behaviors: UploadBehavior[];
  uploadCalls: UploadRequest[] = [];

  constructor(behaviors: UploadBehavior[] = [{ url: "https://viking.example/file", sha256: "abc" }]) {
    this.behaviors = behaviors;
  }

  async upload(request: UploadRequest): Promise<VikingUploadResult> {
    this.uploadCalls.push(request);
    const behavior = this.behaviors.shift() ?? this.behaviors[this.behaviors.length - 1];
    if (behavior instanceof Error) throw behavior;
    return behavior;
  }
}

export class FakePackagingGateway implements PackagingGateway {
  /** Behaviors consumed per createZip call; last one repeats. */
  behaviors: PackageBehavior[];
  createZipCalls: ZipRequest[] = [];

  constructor(behaviors: PackageBehavior[] = [{ sizeBytes: 1234 }]) {
    this.behaviors = behaviors;
  }

  async createZip(request: ZipRequest): Promise<{ zipPath: string; sizeBytes: number }> {
    this.createZipCalls.push(request);
    const behavior = this.behaviors.shift() ?? this.behaviors[this.behaviors.length - 1];
    if (behavior instanceof Error) throw behavior;
    if ("hangUntil" in behavior) return behavior.hangUntil(request.abort);
    return { zipPath: request.outputZipPath, sizeBytes: behavior.sizeBytes };
  }}

export class FakeStorageGateway implements StorageGateway {
  /** Free-byte readings consumed per statFreeBytes call; last one repeats. */
  freeReadings: number[];
  preflightOk: boolean | null = null;
  preflightReason = "insufficient disk space";
  preflightCalls: Array<{ path: string; requiredBytes: number; safetyReserveBytes: number }> = [];

  constructor(freeReadings: number[]) {
    this.freeReadings = freeReadings;
  }

  async statFreeBytes(_path: string): Promise<number> {
    const reading = this.freeReadings.shift() ?? this.freeReadings[this.freeReadings.length - 1];
    return reading;
  }

  async preflight(request: {
    path: string;
    requiredBytes: number;
    safetyReserveBytes: number;
  }): Promise<{ ok: boolean; freeBytes: number | null; reason?: string }> {
    this.preflightCalls.push(request);
    if (this.preflightOk !== null) {
      return { ok: this.preflightOk, freeBytes: 10_000_000, reason: this.preflightOk ? undefined : this.preflightReason };
    }
    const needed = request.requiredBytes + request.safetyReserveBytes;
    const ok = 1_000_000_000 >= needed;
    return { ok, freeBytes: 1_000_000_000, reason: ok ? undefined : this.preflightReason };
  }
}

export class FakeWorkspaceGateway implements WorkspaceGateway {
  root = "/data";
  readonly createdDirs = new Map<string, { jobDir: string; downloadDir: string; packageDir: string }>();
  readonly removed: string[] = [];
  readonly existing = new Set<string>();
  removeShouldThrow: Error | null = null;

  async createJobDirs(jobId: string) {
    const jobDir = joinPosix(this.root, "jobs", jobId);
    const dirs = {
      jobDir,
      downloadDir: joinPosix(jobDir, "download"),
      packageDir: joinPosix(jobDir, "package"),
    };
    this.createdDirs.set(jobId, dirs);
    return dirs;
  }

  async removePath(target: string): Promise<void> {
    this.removed.push(target);
    if (this.removeShouldThrow) throw this.removeShouldThrow;
    this.existing.delete(target);
  }

  join(...parts: string[]): string {
    return joinPosix(...parts);
  }

  async pathExists(target: string): Promise<boolean> {
    if (this.existing.size === 0) return !this.removed.includes(target);
    return this.existing.has(target) && !this.removed.includes(target);
  }
}

/** Memory-backed repository with an upsert snapshot log for ordering asserts. */
export class MemoryJobRepository implements JobRepository {
  readonly #jobs = new Map<string, JobRecord>();
  readonly upsertLog: Array<Record<string, unknown>> = [];

  async loadAll(): Promise<JobRecord[]> {
    return [...this.#jobs.values()];
  }

  async get(id: string): Promise<JobRecord | null> {
    return this.#jobs.get(id) ?? null;
  }

  async findByIdempotencyKey(key: string): Promise<JobRecord | null> {
    for (const record of this.#jobs.values()) {
      if (record.idempotencyKey === key || record.startIdempotencyKey === key) return record;
    }
    return null;
  }

  async upsert(record: JobRecord): Promise<void> {
    this.upsertLog.push(JSON.parse(JSON.stringify(record)) as Record<string, unknown>);
    this.#jobs.set(record.id, record);
  }

  /** Test seeding: insert a record bypassing the log. */
  seed(record: JobRecord): void {
    this.#jobs.set(record.id, record);
  }
}

export function joinPosix(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

export function makeTelemetry(sample: TelemetrySample): TelemetrySample {
  return sample;
}
