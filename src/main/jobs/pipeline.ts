/**
 * TransferPipeline — the authoritative per-job state machine.
 *
 * torrent metadata -> file selection -> disk preflight -> qBit download
 *   -> optional ZIP -> Viking upload -> final result -> cleanup
 *
 * One active pipeline at a time is enforced by the JobEngine, not here.
 * No crash/restart recovery: see JobEngine.startupSweep.
 */
import type {
  DownloadTelemetry,
  FailureKind,
  JobRecord,
  StageName,
} from "./types.ts";
import { InvalidTransitionError } from "./errors.ts";
import type {
  DirectDownloadGateway,
  PackageEntry,
  PackagingGateway,
  StorageGateway,
  TorrentHandle,
  TorrentGateway,
  VikingGateway,
  WorkspaceGateway,
} from "./gateways.ts";
import type { JobRepository } from "./gateways.ts";
import type { JobEngineConfig } from "./config.ts";
import { SpeedHintTracker } from "./speed-hints.ts";
import { computeStorageView } from "./storage.ts";

/** Consecutive poll errors tolerated before the download is declared failed. */
const MAX_CONSECUTIVE_POLL_ERRORS = 10;

function extFromUrl(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    if (dot > 0) return name.slice(dot).slice(0, 12);
  } catch {
    /* ignore */
  }
  return ".bin";
}

export interface PipelineDeps {
  torrent: TorrentGateway;
  direct: DirectDownloadGateway;
  viking: VikingGateway;
  packaging: PackagingGateway;
  storage: StorageGateway;
  workspace: WorkspaceGateway;
  repository: JobRepository;
  config: JobEngineConfig;
}

export interface CancelOptions {
  /**
   * Full job cancellation: also delete local artifacts (partial ZIP, source)
   * and the owned torrent + data. Default false => preserve data where the
   * stage semantics say so (packaging/upload preserve; download always deletes
   * owned torrent+data because a cancelled download has no value).
   */
  cleanup?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TransferPipeline {
  readonly #deps: PipelineDeps;
  readonly #record: JobRecord;
  #handle: TorrentHandle | null = null;
  #cancelRequested = false;
  #cancelCleanup = false;
  readonly #zipAbort = new AbortController();
  readonly #uploadAbort = new AbortController();
  readonly #hints: SpeedHintTracker;

  constructor(deps: PipelineDeps, record: JobRecord) {
    this.#deps = deps;
    this.#record = record;
    this.#hints = new SpeedHintTracker({
      zeroSpeedMs: deps.config.zeroSpeedMs,
      slowSpeedBps: deps.config.slowSpeedBps,
      slowSpeedMs: deps.config.slowSpeedMs,
    });
  }

  /** Snapshot of the live record for the engine. */
  get record(): JobRecord {
    return this.#record;
  }

  // ------------------------------------------------------------------ run

  /** Drive the job from `queued` through completion/failure. */
  async run(): Promise<void> {
    const record = this.#record;
    if (record.state !== "queued") {
      throw new InvalidTransitionError(`pipeline.run() requires state 'queued', got '${record.state}'`);
    }
    if (this.#cancelRequested) {
      await this.#finishCancel();
      return;
    }
    await this.#runDownload();
    if (!this.#shouldContinue()) return;

    if (record.zipRequired) {
      await this.#gatePackagingOnStorage();
      if (!this.#shouldContinue()) return;
      await this.#runPackaging();
    } else {
      record.stages.packaging = "skipped";
      await this.#save();
    }
    if (!this.#shouldContinue()) return;

    await this.#runUpload();
    if (!this.#shouldContinue()) return;

    await this.#runFinalizeAndCleanup();
  }

  /** Resume after a packaging failure. Does NOT redownload. */
  async retryPackaging(): Promise<void> {
    const record = this.#record;
    this.#assertFailedWithKind("packaging");
    if (!record.selection || !record.metadata) {
      throw new InvalidTransitionError("job lacks selection/metadata prerequisites");
    }
    const inputs = this.#packageEntries().map((e) => e.absoluteSourcePath);
    for (const p of inputs) {
      if (!(await this.#deps.workspace.pathExists(p))) {
        throw new InvalidTransitionError(`prerequisite file missing: ${p}`);
      }
    }
    await this.#resetError();
    await this.#runPackaging();
    if (!this.#shouldContinue()) return;
    await this.#runUpload();
    if (!this.#shouldContinue()) return;
    await this.#runFinalizeAndCleanup();
  }

  /** Resume after an upload failure. Does NOT redownload or repackage. */
  async retryUpload(): Promise<void> {
    this.#assertFailedWithKind("upload");
    await this.#resetError();
    await this.#runUpload();
    if (!this.#shouldContinue()) return;
    await this.#runFinalizeAndCleanup();
  }

  /** Re-run the storage check that blocked packaging; continue if it passes. */
  async retryStorageCheck(): Promise<void> {
    this.#assertFailedWithKind("storage_before_packaging");
    await this.#resetError();
    await this.#gatePackagingOnStorage();
    if (!this.#shouldContinue()) return;
    await this.#runPackaging();
    if (!this.#shouldContinue()) return;
    await this.#runUpload();
    if (!this.#shouldContinue()) return;
    await this.#runFinalizeAndCleanup();
  }

  // ------------------------------------------------------------- cancel

  /**
   * Stage-aware cancellation. Safe to call while run()/retry*() is in flight.
   * Returns silently when the job is already terminal.
   */
  async cancel(options: CancelOptions = {}): Promise<void> {
    const record = this.#record;
    if (
      record.state === "complete" ||
      record.state === "cancelled" ||
      record.state === "interrupted"
    ) {
      return;
    }
    if (record.state === "finalizing" && record.result?.url) {
      throw new InvalidTransitionError(
        "cannot cancel: final URL already persisted; job will complete",
      );
    }
    this.#cancelRequested = true;
    this.#cancelCleanup = options.cleanup ?? false;

    switch (record.state) {
      case "reading_metadata":
      case "awaiting_selection":
        // Discard draft; nothing was added to qBittorrent.
        await this.#finishCancel();
        return;
      case "queued":
        // No torrent added yet.
        await this.#finishCancel();
        return;
      case "downloading":
        // Explicit cancel path: the poll loop observes the flag on its next
        // tick and performs stop + guarded deleteOwned(data) exactly once.
        return;
      case "packaging":
        this.#zipAbort.abort(); // handler deletes partial ZIP
        return;
      case "uploading":
        this.#uploadAbort.abort(); // aborts active PUTs cooperatively
        return;
      default:
        return;
    }
  }

  /** Resolve once any in-flight pipeline work settles (engine bookkeeping). */
  settleHook: (() => void) | null = null;

  // ------------------------------------------------------------ phases

  async #runDownload(): Promise<void> {
    const { record } = this;
    const { torrent, storage } = this.#deps;
    record.state = "downloading";
    record.stages.download = "active";
    await this.#save();

    // ---- direct (non-torrent) URL: stream the payload ourselves ----
    if (record.source.kind === "direct") {
      await this.#runDirectDownload();
      return;
    }

    const handle = await torrent.addTorrent(record.source, {
      selectedIndexes: record.selection!,
      outputDir: record.downloadDir!,
      jobId: record.id,
      tag: this.#deps.config.ownershipTag,
    });
    this.#handle = handle;
    record.torrentId = handle.torrentId;

    let consecutiveErrors = 0;
    let lastTelemetry: DownloadTelemetry | null = null;
    for (;;) {
      if (this.#cancelRequested) break;
      let telemetry: DownloadTelemetry;
      try {
        telemetry = await torrent.getProgress(handle);
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          await this.#fail("download", `torrent progress polling failed repeatedly: ${String(error)}`);
          return;
        }
        await sleep(this.#deps.config.pollIntervalMs);
        continue;
      }

      telemetry.at = Date.now();
      lastTelemetry = telemetry;
      record.telemetry = telemetry;

      const freeBytes = await storage.statFreeBytes(record.downloadDir!);
      const downloaded = Math.max(0, telemetry.downloadedBytes);
      const selectedTotal = record.selectedBytes ?? 0;
      record.storage = await this.#liveStorageView(freeBytes, downloaded, selectedTotal);
      record.hint = this.#hints.observe(telemetry, Date.now());
      await this.#save();

      if (record.storage.warning === "critical") {
        // Exhaustion imminent: stop safely instead of letting disk hit zero.
        try {
          await torrent.stop(handle);
        } catch {
          /* adapter blocking semantics may have already paused it */
        }
        await this.#fail(
          "download",
          "disk space critically low during download; torrent stopped to protect the filesystem",
          true,
        );
        return;
      }

      if (telemetry.selectedComplete) break;
      if (this.#cancelRequested) break;

      await sleep(this.#deps.config.pollIntervalMs);
    }

    if (this.#cancelRequested) {
      // Covers cancel racing addTorrent: ensure the owned torrent is removed.
      try {
        await torrent.stop(handle);
      } catch {
        /* best effort */
      }
      try {
        await torrent.deleteOwned(handle, true);
      } catch {
        /* best effort */
      }
      await this.#finishCancel();
      return;
    }

    // Selected files complete: stop torrent activity.
    try {
      await torrent.stop(handle);
    } catch {
      /* already stopped/seeding disabled — not fatal */
    }
    record.stages.download = "complete";

    const completed = lastTelemetry?.selectedFiles ?? [];
    const byIndex = new Map(completed.map((f) => [f.index, f.absolutePath]));
    const missing = record.selection!.filter((idx) => !byIndex.has(idx));
    if (missing.length > 0) {
      await this.#fail(
        "download",
        `gateway did not report absolute paths for selected files: ${missing.join(", ")}`,
      );
      return;
    }
    record.completedFiles = [...byIndex.entries()].map(([index, absolutePath]) => ({
      index,
      absolutePath,
    }));

    if (!record.zipRequired) {
      record.directSourcePath = byIndex.get(record.selection![0])!;
      record.stages.packaging = "skipped";
    }
    await this.#save();
  }

  /** Non-torrent URL: stream the file straight into the job's download dir. */
  async #runDirectDownload(): Promise<void> {
    const { record } = this;
    const filename =
      record.metadata?.files[0]?.path ?? `download-${record.id}${extFromUrl(record.source.value)}`;
    const destPath = await this.#deps.workspace.joinDownload(record.downloadDir!, filename);
    let lastSave = 0;

    try {
      await this.#deps.direct.fetchTo(record.source.value, destPath, (downloaded, total) => {
        record.telemetry = {
          progressPct: total ? Math.min(100, Math.round((downloaded / total) * 100)) : 0,
          downloadedBytes: downloaded,
          totalSelectedBytes: total ?? record.selectedBytes ?? 0,
          speedBps: 0,
          etaSeconds: null,
          seeds: 0,
          peers: 0,
          selectedComplete: false,
          at: Date.now(),
        };
        // Throttle persistence to ~1/s like the torrent poller.
        if (Date.now() - lastSave > 1000) {
          lastSave = Date.now();
          void this.#save();
        }
      });
    } catch (error) {
      await this.#fail("download", `direct download failed: ${String(error)}`);
      return;
    }

    if (this.#cancelRequested) {
      await this.#applyCancelCleanup();
      await this.#finishCancel();
      return;
    }

    const size = (await this.#deps.workspace.statFile(destPath)).sizeBytes;
    record.selectedBytes = size;
    record.telemetry = {
      progressPct: 100,
      downloadedBytes: size,
      totalSelectedBytes: size,
      speedBps: 0,
      etaSeconds: null,
      seeds: 0,
      peers: 0,
      selectedComplete: true,
      at: Date.now(),
    };
    record.stages.download = "complete";
    record.completedFiles = [{ index: 0, absolutePath: destPath }];
    record.directSourcePath = destPath;
    record.stages.packaging = "skipped"; // single payload — no ZIP
    await this.#save();
  }

  /** Fresh disk-space check before starting the ZIP (canonical policy when available). */
  async #gatePackagingOnStorage(): Promise<void> {
    const { record } = this;
    const freeBytes = await this.#deps.storage.statFreeBytes(record.downloadDir!);
    const selectedBytes = record.selectedBytes ?? 0;
    const fileCount = record.selection?.length ?? 1;
    if (this.#deps.storage.evaluatePackagingStart) {
      const evaluation = await this.#deps.storage.evaluatePackagingStart({
        path: record.downloadDir!,
        selectedBytes,
        fileCount,
      });
      if (!evaluation.allowed) {
        const deficit = evaluation.deficitBytes ?? 0;
        record.storage = await this.#liveStorageView(freeBytes, selectedBytes, selectedBytes);
        await this.#fail(
          "storage_before_packaging",
          `insufficient disk space to package: need ~${evaluation.requiredAdditionalBytes ?? "?"} more bytes, ${deficit} short; ${freeBytes ?? "unknown"} free`,
          true,
        );
      }
      return;
    }
    // Legacy coarse fallback: ZIP needs roughly its input size while both exist.
    const required = selectedBytes + this.#deps.config.safetyReserveBytes;
    if (freeBytes !== null && freeBytes < required) {
      // Do NOT begin the ZIP; preserve the completed download.
      record.storage = computeStorageView({
        freeBytes,
        remainingDownloadBytes: 0,
        zipReservationBytes: selectedBytes,
        safetyReserveBytes: this.#deps.config.safetyReserveBytes,
        lowHeadroomBytes: this.#deps.config.lowHeadroomBytes,
      });
      await this.#fail(
        "storage_before_packaging",
        `insufficient disk space to package: need ~${required} bytes, ${freeBytes} free`,
        true,
      );
    }
  }

  /** Live storage view via the canonical adapter when available, coarse math otherwise. */
  async #liveStorageView(
    freeBytes: number | null,
    downloadedSelectedBytes: number,
    selectedTotalBytes: number,
  ): Promise<NonNullable<JobRecord["storage"]>> {
    const { record } = this;
    if (this.#deps.storage.liveHeadroom) {
      return await this.#deps.storage.liveHeadroom({
        path: record.downloadDir!,
        freeBytes,
        selectedTotalBytes,
        downloadedSelectedBytes,
        zipRequired: record.zipRequired === true,
        fileCount: record.selection?.length ?? 1,
      });
    }
    const remaining = Math.max(0, selectedTotalBytes - downloadedSelectedBytes);
    const zipReservation = record.zipRequired ? selectedTotalBytes : 0;
    return computeStorageView({
      freeBytes,
      remainingDownloadBytes: remaining,
      zipReservationBytes: zipReservation,
      safetyReserveBytes: this.#deps.config.safetyReserveBytes,
      lowHeadroomBytes: this.#deps.config.lowHeadroomBytes,
    });
  }

  /**
   * Progress callbacks can fire per chunk; persisting on every tick would
   * thrash the JSON history. Persist at most every ~750 ms instead.
   */
  #throttledSaver(): () => Promise<void> {
    let last = 0;
    let pending: Promise<void> = Promise.resolve();
    return () => {
      const now = Date.now();
      if (now - last < 750) return pending;
      last = now;
      pending = this.#save().catch(() => {});
      return pending;
    };
  }

  /** Explicit entries for the packaging adapter, in canonical selection order. */
  #packageEntries(): PackageEntry[] {
    const { record } = this;
    if (!record.metadata || !record.selection) {
      throw new InvalidTransitionError("job lacks metadata/selection prerequisites");
    }
    const metaByIndex = new Map(record.metadata.files.map((f) => [f.index, f]));
    const doneByIndex = new Map(
      (record.completedFiles ?? []).map((f) => [f.index, f.absolutePath]),
    );
    return record.selection.map((idx) => {
      const meta = metaByIndex.get(idx);
      const absolutePath = doneByIndex.get(idx);
      if (!meta) throw new InvalidTransitionError(`no metadata for file index ${idx}`);
      if (!absolutePath) {
        throw new InvalidTransitionError(`no completed path for file index ${idx}`);
      }
      return {
        absoluteSourcePath: absolutePath,
        archiveRelativePath: meta.path,
        sizeBytes: meta.sizeBytes,
        torrentFileIndex: idx,
      };
    });
  }

  async #runPackaging(): Promise<void> {
    const { record } = this;
    record.state = "packaging";
    record.stages.packaging = "active";
    await this.#save();

    const zipName = `${record.metadata!.name}.zip`;
    const zipPath = this.#deps.workspace.join(record.packageDir!, zipName);
    const entries = this.#packageEntries();
    const persistProgress = this.#throttledSaver();
    try {
      const result = await this.#deps.packaging.createZip({
        entries,
        outputZipPath: zipPath,
        abort: this.#zipAbort.signal,
        onProgress: (progress) => {
          record.packagingProgress = progress;
          void persistProgress();
        },
      });
      record.packagingProgress = null;
      if (this.#cancelRequested) {
        await this.#removePartialZip(zipPath);
        await this.#finishCancel();
        return;
      }
      record.zipPath = result.zipPath;
      record.stages.packaging = "complete";
      await this.#save();
    } catch (error) {
      record.packagingProgress = null;
      await this.#removePartialZip(zipPath);
      if (this.#cancelRequested) {
        await this.#applyCancelCleanup();
        await this.#finishCancel();
        return;
      }
      await this.#fail("packaging", `packaging failed: ${String(error)}`);
    }
  }

  async #runUpload(): Promise<void> {
    const { record } = this;
    const source = record.zipRequired ? record.zipPath : record.directSourcePath;
    if (!source) {
      await this.#fail("upload", "no packaged source available for upload");
      return;
    }
    record.state = "uploading";
    record.stages.upload = "active";
    await this.#save();

    const fileName = record.zipRequired
      ? `${record.metadata!.name}.zip`
      : baseName(source);
    const persistProgress = this.#throttledSaver();

    try {
      const result = await this.#deps.viking.upload({
        filePath: source,
        fileName,
        sizeBytes: record.zipRequired ? null : (record.selectedBytes ?? null),
        abort: this.#uploadAbort.signal,
        onProgress: (progress) => {
          record.uploadProgress = progress;
          void persistProgress();
        },
      });
      record.uploadProgress = null;
      if (this.#cancelRequested) {
        // Upload finished racing a cancel: keep local source unless full cleanup.
        await this.#applyCancelCleanup();
        await this.#finishCancel();
        return;
      }
      this.#uploadResult = result;
      record.stages.upload = "complete";
      await this.#save();
    } catch (error) {
      if (this.#cancelRequested) {
        // Preserve local source unless full job cancellation requested cleanup.
        await this.#applyCancelCleanup();
        await this.#finishCancel();
        return;
      }
      await this.#fail("upload", `viking upload failed: ${String(error)}`);
    }
  }

  #uploadResult: { url: string; sha256?: string | null; sizeBytes?: number | null } | null = null;

  async #runFinalizeAndCleanup(): Promise<void> {
    const { record } = this;
    record.state = "finalizing";
    record.stages.finalize = "active";
    await this.#save();

    if (!this.#uploadResult) {
      await this.#fail("finalize", "internal: upload result missing at finalize");
      return;
    }

    let verified: boolean | null = null;
    if (typeof this.#deps.viking.verify === "function") {
      try {
        verified = await this.#deps.viking.verify(this.#uploadResult);
      } catch {
        verified = null; // verification is optional and never fails the job
      }
    }

    // Persist the final URL/hash BEFORE any destructive cleanup.
    record.result = {
      url: this.#uploadResult.url,
      sha256: this.#uploadResult.sha256 ?? null,
      sizeBytes: this.#uploadResult.sizeBytes ?? null,
      cleanupWarning: null,
      verified,
    };
    record.stages.finalize = "complete";
    await this.#save();

    // ---- cleanup ----
    record.state = "complete"; // success is locked in before destructive steps
    record.stages.cleanup = "active";
    await this.#save();

    try {
      const policy = record.cleanupPolicy ?? {
        deleteTorrent: true,
        deleteFiles: true,
        deleteZip: true,
      };
      if (record.zipRequired && record.zipPath && policy.deleteZip) {
        await this.#deps.workspace.removePath(record.zipPath);
      }
      const handle = this.#ownedHandle();
      if (handle && policy.deleteTorrent) {
        await this.#deps.torrent.deleteOwned(handle, policy.deleteFiles);
      }
      record.stages.cleanup = "complete";
    } catch (error) {
      // Upload succeeded and URL is durably saved: NEVER downgrade to failed.
      record.result.cleanupWarning = String(error);
      record.stages.cleanup = "failed";
    }
    await this.#save();
    this.settleHook?.();
  }

  // ------------------------------------------------------------ helpers

  #assertFailedWithKind(kind: FailureKind): void {
    const { record } = this;
    if (record.state !== "failed" || record.error?.kind !== kind) {
      throw new InvalidTransitionError(
        `retry ${kind} requires failed job with error kind '${kind}' (state=${record.state}, error=${record.error?.kind ?? "none"})`,
      );
    }
  }

  /**
   * Clear the failure and return the job to a neutral in-progress state so
   * phase-continuation checks pass during retry runs.
   */
  async #resetError(): Promise<void> {
    this.#record.error = null;
    this.#record.state = "queued";
    await this.#save();
  }

  #shouldContinue(): boolean {
    const s = this.#record.state;
    return s !== "failed" && s !== "cancelled" && !this.#cancelRequested;
  }

  async #fail(kind: FailureKind, message: string, insufficientSpace = false): Promise<void> {
    const { record } = this;
    record.state = "failed";
    record.error = { kind, message, insufficientSpace };
    const stageFor: Record<FailureKind, StageName> = {
      metadata: "metadata",
      storage_preflight: "preflight",
      download: "download",
      storage_before_packaging: "packaging",
      packaging: "packaging",
      upload: "upload",
      finalize: "finalize",
    };
    record.stages[stageFor[kind]] = "failed";
    await this.#save();
    this.settleHook?.();
  }

  async #finishCancel(): Promise<void> {
    const { record } = this;
    record.state = "cancelled";
    await this.#save();
    this.settleHook?.();
  }

  /** Delete partial ZIP / local artifacts when full cancellation was requested. */
  async #applyCancelCleanup(): Promise<void> {
    if (!this.#cancelCleanup) return;
    const { record } = this;
    if (record.zipRequired && record.zipPath) {
      await this.#deps.workspace.removePath(record.zipPath).catch(() => {});
    }
    const handle = this.#ownedHandle();
    if (handle) {
      try {
        await this.#deps.torrent.deleteOwned(handle, true);
      } catch {
        /* best effort */
      }
    }
  }

  /** Live handle, or one reconstructed from the persisted torrent id (retry paths). */
  #ownedHandle(): TorrentHandle | null {
    if (this.#handle) return this.#handle;
    if (this.#record.torrentId) {
      return {
        torrentId: this.#record.torrentId,
        jobId: this.#record.id,
        infoHash: this.#record.torrentId,
        savePathPrefix: this.#record.downloadDir ?? undefined,
      };
    }
    return null;
  }

  async #removePartialZip(zipPath: string): Promise<void> {
    await this.#deps.workspace.removePath(zipPath).catch(() => {});
  }

  async #save(): Promise<void> {
    this.#record.updatedAt = new Date().toISOString();
    await this.#deps.repository.upsert(this.#record);
  }
}

function baseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}
