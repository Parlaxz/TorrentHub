/**
 * JobEngine — public facade for the A5 transfer pipeline.
 *
 * V1 concurrency: ONE active transfer pipeline at a time. Intake drafts
 * (metadata/selection) are allowed while a transfer runs.
 *
 * Crash/restart policy: intentionally minimal. startupSweep() marks
 * nonterminal jobs from previous sessions as 'interrupted' and does NOT
 * inspect qBittorrent or resume any stage.
 */
import type { CleanupPolicy, FailureKind, IntakeSource, JobRecord, StageName, TorrentMetadataInfo } from "./types.ts";
import { STAGE_NAMES, initialStageMap, isTerminalJobState } from "./types.ts";
import {
  InsufficientSpaceError,
  InvalidTransitionError,
  JobEngineError,
  JobNotFoundError,
} from "./errors.ts";
import type {
  DirectDownloadGateway,
  JobRepository,
  PackagingGateway,
  StorageGateway,
  TorrentGateway,
  VikingGateway,
  WorkspaceGateway,
} from "./gateways.ts";
import { resolveConfig, type JobEngineConfig } from "./config.ts";
import { newJobId, newSessionEpoch, normalizeIdempotencyKey } from "./ids.ts";
import { TransferPipeline, type CancelOptions, type PipelineDeps } from "./pipeline.ts";

export interface JobEngineDeps {
  torrent: TorrentGateway;
  direct: DirectDownloadGateway;
  viking: VikingGateway;
  packaging: PackagingGateway;
  storage: StorageGateway;
  workspace: WorkspaceGateway;
  repository: JobRepository;
}

export class JobEngine {
  readonly #deps: JobEngineDeps;
  readonly #config: JobEngineConfig;
  readonly #epoch: string;
  readonly #log: JobEngineConfig["logger"];
  /** Serializes transfer ownership (one active transfer at a time). */
  #transferChain: Promise<void> = Promise.resolve();
  #activeTransferJobId: string | null = null;
  #activePipeline: TransferPipeline | null = null;
  /** In-flight intake dedup for concurrent identical createIntake calls. */
  readonly #pendingIntakes = new Map<string, Promise<JobRecord>>();

  constructor(deps: JobEngineDeps, config: JobEngineConfig) {
    this.#deps = deps;
    this.#config = resolveConfig(config);
    this.#log = this.#config.logger;
    this.#epoch = newSessionEpoch();
  }

  get sessionEpoch(): string {
    return this.#epoch;
  }

  // ----------------------------------------------------------- startup

  /**
   * Mark nonterminal jobs from PREVIOUS sessions as interrupted.
   * Does not inspect qBittorrent; does not resume ZIP/upload state.
   * Returns the number of jobs marked.
   */
  async startupSweep(): Promise<number> {
    const jobs = await this.#deps.repository.loadAll();
    let marked = 0;
    for (const job of jobs) {
      if (isTerminalJobState(job.state)) continue;
      // Drafts that never started a transfer survive restarts untouched —
      // the user can still select files and start them.
      if (job.state === "reading_metadata" || job.state === "awaiting_selection") continue;
      if (job.sessionEpoch === this.#epoch) continue; // current-session job
      job.state = "interrupted";
      job.lastKnownStage = lastNonWaitingStage(job.stages);
      await this.#save(job);
      marked += 1;
    }
    return marked;
  }

  // ------------------------------------------------------------- intake

  /**
   * Create an intake draft from a magnet link or HTTP(S) torrent URL.
   * Fetches metadata only. With an idempotency key, repeated calls return
   * the same draft/job instead of creating duplicates.
   */
  async createIntake(
    sourceInput: string,
    idempotencyKey?: string | null,
    clientId?: string | null,
  ): Promise<JobRecord> {
    const source = parseIntakeSource(sourceInput);
    const key = normalizeIdempotencyKey(idempotencyKey);

    if (key) {
      const existing = await this.#deps.repository.findByIdempotencyKey(key);
      if (existing) return existing;
      const pending = this.#pendingIntakes.get(key);
      if (pending) return pending;
    }

    const creation = this.#createIntakeInner(source, key, clientId ?? null);
    if (!key) return creation;
    this.#pendingIntakes.set(key, creation);
    try {
      return await creation;
    } finally {
      this.#pendingIntakes.delete(key);
    }
  }

  async #createIntakeInner(
    source: IntakeSource,
    key: string | null,
    clientId: string | null,
  ): Promise<JobRecord> {
    const now = new Date().toISOString();
    const record: JobRecord = {
      id: newJobId(),
      createdAt: now,
      updatedAt: now,
      state: "reading_metadata",
      source,
      clientId,
      idempotencyKey: key,
      stages: initialStageMap(),
      metadata: null,
      result: null,
      error: null,
      sessionEpoch: this.#epoch,
    };

    // Direct downloads need no torrent metadata: probe the URL for a
    // filename + size and go straight to file selection.
    if (source.kind === "direct") {
      record.stages.metadata = "active";
      await this.#save(record);
      try {
        const probe = await this.#deps.direct.probe(source.value);
        record.metadata = {
          name: probe.filename,
          files: [{ index: 0, path: probe.filename, sizeBytes: probe.sizeBytes }],
          totalSizeBytes: probe.sizeBytes,
        };
        record.stages.metadata = "complete";
        record.stages.selection = "waiting";
        record.state = "awaiting_selection";
      } catch (error) {
        record.stages.metadata = "failed";
        record.state = "failed";
        record.error = { kind: "metadata", message: `direct link probe failed: ${String(error)}` };
      }
      await this.#save(record);
      return record;
    }

    record.stages.metadata = "active";
    await this.#save(record);

    try {
      const metadata: TorrentMetadataInfo = await this.#deps.torrent.fetchMetadata(source);
      if (record.state !== "reading_metadata") {
        return record; // cancelled while metadata was in flight; keep that outcome
      }
      record.metadata = metadata;
      record.stages.metadata = "complete";
      record.stages.selection = "waiting";
      record.state = "awaiting_selection";
    } catch (error) {
      if (record.state !== "reading_metadata") return record;
      record.stages.metadata = "failed";
      record.state = "failed";
      record.error = { kind: "metadata", message: `metadata fetch failed: ${String(error)}` };
    }
    await this.#save(record);
    return record;
  }

  // ------------------------------------------------------------- commit

  /**
   * Commit the file selection and start the transfer.
   * - validates selected indexes are nonempty and known
   * - computes selected size; zipRequired = count > 1
   * - storage preflight rejects Start when peak space is unsafe
   * - creates <jobsRoot>/jobs/<jobId>/{download,package}
   * Idempotent by key: replaying Start returns the same job.
   */
  async commitSelection(
    jobId: string,
    selectedIndexes: number[],
    idempotencyKey?: string | null,
    cleanupOverrides?: Partial<CleanupPolicy> | null,
  ): Promise<JobRecord> {
    const record = await this.#require(jobId);
    const key = normalizeIdempotencyKey(idempotencyKey);

    if (key) {
      const existing = await this.#deps.repository.findByIdempotencyKey(key);
      if (existing && existing.id !== jobId) return existing; // duplicate protection
    }
    // Lost-response replay of an already-started job with the same Start key.
    if (key && record.startIdempotencyKey === key && record.state !== "awaiting_selection") {
      return record;
    }
    if (record.state !== "awaiting_selection") {
      throw new InvalidTransitionError(`cannot commit selection in state '${record.state}'`);
    }
    if (this.#activeTransferJobId !== null) {
      throw new InvalidTransitionError("another transfer is active; V1 allows one at a time");
    }
    if (!record.metadata) throw new InvalidTransitionError("job has no metadata");

    const indexes = [...new Set(selectedIndexes)].sort((a, b) => a - b);
    if (indexes.length === 0) {
      throw new InvalidTransitionError("selection must contain at least one file");
    }
    const known = new Set(record.metadata.files.map((f) => f.index));
    const unknown = indexes.filter((i) => !known.has(i));
    if (unknown.length > 0) {
      throw new InvalidTransitionError(`unknown file indexes: ${unknown.join(", ")}`);
    }

    const selectedBytes = record.metadata.files
      .filter((f) => indexes.includes(f.index))
      .reduce((sum, f) => sum + f.sizeBytes, 0);
    const zipRequired = indexes.length > 1;

    record.selection = indexes;
    record.selectedBytes = selectedBytes;
    record.zipRequired = zipRequired;
    record.cleanupPolicy = {
      deleteTorrent:
        cleanupOverrides?.deleteTorrent ?? this.#config.cleanupDefaults.deleteTorrent,
      deleteFiles: cleanupOverrides?.deleteFiles ?? this.#config.cleanupDefaults.deleteFiles,
      deleteZip: cleanupOverrides?.deleteZip ?? this.#config.cleanupDefaults.deleteZip,
    };

    // ---- disk preflight: reject Start if peak space is unsafe ----
    // The storage adapter applies the authoritative disk-space policy
    // (estimated ZIP bytes + safety reserve + peak) from these canonical
    // selection facts; requiredBytes/safetyReserveBytes are legacy fallbacks.
    record.stages.preflight = "active";
    const peakBytes = selectedBytes + (zipRequired ? selectedBytes : 0);
    const verdict = await this.#deps.storage.preflight({
      path: this.#config.jobsRoot,
      requiredBytes: peakBytes,
      safetyReserveBytes: this.#config.safetyReserveBytes,
      selectedBytes,
      fileCount: indexes.length,
      zipRequired,
    });
    const freeForView = verdict.freeBytes;
    const requiredForView =
      verdict.requiredPeakBytes ?? peakBytes + this.#config.safetyReserveBytes;
    const deficitForView =
      freeForView !== null ? Math.max(0, requiredForView - freeForView) : null;
    const blocked = !verdict.ok;
    // Unknown free space is NOT insufficiency: the policy is "proceed without
    // blocking" when the volume cannot be stat'd. Treating null as failure
    // produced "Blocked — need 0 GB more" on healthy disks.
    const unknownFree = freeForView === null && !blocked;
    record.preflight = {
      selectedFiles: indexes.length,
      selectedBytes,
      tempZipBytes: zipRequired ? (verdict.estimatedZipBytes ?? selectedBytes) : null,
      safetyReserveBytes: verdict.safetyReserveBytes ?? this.#config.safetyReserveBytes,
      peakRequiredBytes: requiredForView,
      serverFreeBytes: freeForView,
      enough: !blocked && (unknownFree || deficitForView === 0),
      missingBytes: blocked ? (verdict.deficitBytes ?? deficitForView ?? 0) : 0,
      blocked,
    };
    this.#log?.info(
      {
        jobId: record.id,
        status: blocked ? 'blocked' : unknownFree ? 'unknown-free' : 'ok',
        freeBytes: freeForView,
        requiredPeakBytes: requiredForView,
        zipRequired,
      },
      'storage preflight',
    );
    if (!verdict.ok) {
      record.stages.preflight = "failed";
      record.error = {
        kind: "storage_preflight",
        message: verdict.reason ?? "insufficient disk space for this selection",
        insufficientSpace: true,
      };
      await this.#save(record); // stays awaiting_selection; user can retry Start
      throw new InsufficientSpaceError(
        record.error.message,
        requiredForView,
        freeForView,
      );
    }
    record.storage = {
      freeBytes: verdict.freeBytes,
      remainingDownloadBytes: selectedBytes,
      zipReservationBytes: zipRequired ? (verdict.estimatedZipBytes ?? selectedBytes) : null,
      safetyReserveBytes: verdict.safetyReserveBytes ?? this.#config.safetyReserveBytes,
      projectedHeadroomBytes:
        verdict.freeBytes !== null
          ? verdict.freeBytes - requiredForView
          : null,
      warning: "none",
    };
    record.stages.preflight = "complete";

    // ---- per-job directory ----
    const dirs = await this.#deps.workspace.createJobDirs(jobId);
    record.jobDir = dirs.jobDir;
    record.downloadDir = dirs.downloadDir;
    record.packageDir = dirs.packageDir;

    record.stages.selection = "complete";
    record.startIdempotencyKey = key ?? record.startIdempotencyKey ?? null;
    record.state = "queued";
    await this.#save(record);

    this.#startTransfer(record);
    return record;
  }

  // ------------------------------------------------------------ control

  /** Stage-aware cancellation. See TransferPipeline.cancel for semantics. */
  /** Archive/unarchive a terminal job (UI history filtering only). */
  async setArchived(jobId: string, archived: boolean): Promise<JobRecord> {
    const record = await this.#require(jobId);
    if (!isTerminalJobState(record.state)) {
      throw new InvalidTransitionError("only terminal jobs can be archived");
    }
    record.archived = archived;
    await this.#save(record);
    return record;
  }

  async cancel(jobId: string, options: CancelOptions = {}): Promise<JobRecord> {    const record = await this.#require(jobId);
    if (isTerminalJobState(record.state)) return record;

    const live = this.#activePipeline;
    if (live && live.record.id === jobId) {
      await live.cancel(options);
      return record;
    }

    // No live pipeline bound to this job (draft states, or queued but not yet
    // picked up because another transfer is active).
    switch (record.state) {
      case "reading_metadata":
      case "awaiting_selection":
      case "queued":
        record.state = "cancelled";
        await this.#save(record);
        return record;
      default:
        throw new InvalidTransitionError(
          `no active pipeline for job '${jobId}' in state '${record.state}'`,
        );
    }
  }

  /** Retry packaging after a packaging failure. Never redownloads. */
  retryPackaging(jobId: string): Promise<void> {
    return this.#resume(jobId, "retryPackaging");
  }

  /** Retry upload after an upload failure. Never redownloads/repackages. */
  retryUpload(jobId: string): Promise<void> {
    return this.#resume(jobId, "retryUpload");
  }

  /** Re-run the storage check that blocked packaging; continue if it passes. */
  retryStorageCheck(jobId: string): Promise<void> {
    return this.#resume(jobId, "retryStorageCheck");
  }

  /**
   * Explicit user-requested cleanup for terminal jobs: guarded-delete the
   * owned torrent + data (when its id is known) and remove local job files.
   */
  async discardArtifacts(jobId: string): Promise<void> {
    const record = await this.#require(jobId);
    if (!isTerminalJobState(record.state)) {
      throw new InvalidTransitionError("can only discard artifacts of terminal jobs");
    }
    if (record.torrentId) {
      try {
        await this.#deps.torrent.deleteOwned(
          {
            torrentId: record.torrentId,
            jobId: record.id,
            infoHash: record.torrentId,
            savePathPrefix: record.downloadDir ?? undefined,
          },
          true,
        );
      } catch {
        /* guarded adapter may refuse unknown/unowned torrents — best effort */
      }
    }
    if (record.jobDir) {
      await this.#deps.workspace.removePath(record.jobDir);
    }
  }

  // ------------------------------------------------------------ queries

  async getJob(jobId: string): Promise<JobRecord> {
    return this.#require(jobId);
  }

  async listJobs(): Promise<JobRecord[]> {
    const jobs = await this.#deps.repository.loadAll();
    return jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Resolves when no transfer is running (tests / graceful shutdown). */
  async whenIdle(): Promise<void> {
    await this.#transferChain;
  }

  // ------------------------------------------------------------ private

  #startTransfer(record: JobRecord): void {
    const pipeline = new TransferPipeline(this.#pipelineDeps(), record);
    this.#activePipeline = pipeline;
    this.#activeTransferJobId = record.id;
    // Sanitize the chain AFTER each run: a rejected link must never poison
    // subsequent transfers (they would silently never execute and later be
    // swept to "interrupted").
    const run = this.#transferChain.then(() =>
      this.#runTracked(pipeline, () => pipeline.run(), record.id),
    );
    this.#transferChain = run.then(
      () => undefined,
      () => undefined,
    );
  }

  #resume(
    jobId: string,
    method: "retryPackaging" | "retryUpload" | "retryStorageCheck",
  ): Promise<void> {
    if (this.#activeTransferJobId !== null && this.#activeTransferJobId !== jobId) {
      return Promise.reject(new InvalidTransitionError("another transfer is active"));
    }
    const run = this.#transferChain.then(async () => {
      const record = await this.#require(jobId);
      const pipeline = new TransferPipeline(this.#pipelineDeps(), record);
      this.#activePipeline = pipeline;
      this.#activeTransferJobId = jobId;
      await this.#runTracked(pipeline, () => pipeline[method](), jobId);
    });
    this.#transferChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #runTracked(
    pipeline: TransferPipeline,
    action: () => Promise<void>,
    jobId: string,
  ): Promise<void> {
    const record = pipeline.record;
    try {
      await action();
    } catch (error) {
      // Unexpected engine bug outside phase handlers: fail safely, keep data.
      if (!(error instanceof InvalidTransitionError) && !isTerminalJobState(record.state)) {
        record.state = "failed";
        record.error ??= {
          kind: kindForState(record),
          message: `unexpected pipeline error: ${String(error)}`,
        };
        await this.#save(record);
      }
      this.#log.warn(
        {
          jobId,
          state: record.state,
          err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
        },
        "transfer pipeline failed",
      );
      throw error;
    } finally {
      if (this.#activeTransferJobId === jobId) this.#activeTransferJobId = null;
      if (this.#activePipeline === pipeline) this.#activePipeline = null;
    }
  }

  #pipelineDeps(): PipelineDeps {
    return {
      torrent: this.#deps.torrent,
      direct: this.#deps.direct,
      viking: this.#deps.viking,
      packaging: this.#deps.packaging,
      storage: this.#deps.storage,
      workspace: this.#deps.workspace,
      repository: this.#deps.repository,
      config: this.#config,
    };
  }

  async #require(jobId: string): Promise<JobRecord> {
    const record = await this.#deps.repository.get(jobId);
    if (!record) throw new JobNotFoundError(jobId);
    return record;
  }

  async #save(record: JobRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    await this.#deps.repository.upsert(record);
  }
}

function parseIntakeSource(input: string): IntakeSource {
  const trimmed = input.trim();
  if (trimmed.startsWith("magnet:")) return { kind: "magnet", value: trimmed };
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    // .torrent URLs go through qBittorrent; everything else is a DIRECT
    // download fetched by the server itself (no torrent client involved).
    let path = trimmed;
    try {
      path = new URL(trimmed).pathname;
    } catch {
      /* keep the raw value for the extension check */
    }
    if (/\.torrent$/i.test(path)) return { kind: "url", value: trimmed };
    return { kind: "direct", value: trimmed };
  }
  throw new JobEngineError("source must be a magnet link or http(s) URL");
}

function lastNonWaitingStage(stages: Record<StageName, string>): StageName | null {
  for (let i = STAGE_NAMES.length - 1; i >= 0; i -= 1) {
    if (stages[STAGE_NAMES[i]] !== "waiting") return STAGE_NAMES[i];
  }
  return null;
}

function kindForState(record: JobRecord): FailureKind {
  switch (record.state) {
    case "packaging":
      return "packaging";
    case "uploading":
      return "upload";
    case "finalizing":
      return "finalize";
    default:
      return "download";
  }
}
