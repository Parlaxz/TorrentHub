/**
 * Viking Relay — A5 narrow gateway interfaces.
 *
 * The job engine depends ONLY on these interfaces (dependency injection).
 * Concrete qBittorrent / Viking / packaging / storage adapters live in
 * src/main/integration and are wired by Electron main.
 *
 * B1 integration notes:
 *  - ZipRequest carries EXPLICIT package entries (source path + torrent-
 *    relative archive path + declared size) so the packaging adapter can
 *    preserve the torrent's logical hierarchy without basename flattening.
 *  - PreflightRequest carries the canonical selection facts so the storage
 *    adapter can apply the authoritative disk-space policy (estimated ZIP
 *    bytes, safety reserve, peak) instead of engine-side approximations.
 *  - Zip/Upload requests accept optional progress callbacks; the pipeline
 *    persists them on the JobRecord for renderer telemetry.
 */
import type {
  DownloadTelemetry,
  IntakeSource,
  TorrentMetadataInfo,
} from "./types.ts";

/** Ownership tag applied to every torrent the engine creates. */
export const VIKING_RELAY_TAG = "viking-relay";

/**
 * Direct (non-torrent) HTTP(S) download adapter. Used when an intake URL
 * does not point at a .torrent file — the server fetches the payload itself.
 */
export interface DirectDownloadGateway {
  /** HEAD/GET probe for filename + size without downloading the body. */
  probe(url: string): Promise<{ filename: string; sizeBytes: number }>;
  /** Streams the payload to destPath, reporting progress. Resolves with bytes written. */
  fetchTo(
    url: string,
    destPath: string,
    onProgress?: (downloaded: number, total: number | null) => void,
  ): Promise<{ bytes: number }>;
}

export interface AddTorrentOptions {
  /** Exact file indexes selected by the user; all others get priority 0. */
  selectedIndexes: number[];
  /** Directory the torrent downloads into. */
  outputDir: string;
  /**
   * Owning job id. Concrete adapters derive their job-specific ownership
   * markers (e.g. vr_job_<jobId>) from this; destructive operations must
   * re-validate hash + ownership + save path before deleting.
   */
  jobId: string;
  /** Legacy generic tag; adapters must NOT weaken per-job proofs to this. */
  tag?: string;
}

export interface TorrentHandle {
  /** Adapter-specific torrent identifier (hash or id). Opaque to the engine. */
  torrentId: string;
  /** Owning job id (carried so reconstructed handles keep full proof). */
  jobId?: string;
  /** Canonical torrent hash when the adapter uses hashes as ids. */
  infoHash?: string;
  /** Per-job download root the torrent was committed into. */
  savePathPrefix?: string;
}

/**
 * qBittorrent adapter surface used by the engine.
 * Implementations must be "guarded": deleteOwned may only remove torrents
 * whose identity AND per-job ownership markers match the recorded job.
 */
export interface TorrentGateway {
  /** Metadata only — does not add the torrent to the download queue. */
  fetchMetadata(source: IntakeSource): Promise<TorrentMetadataInfo>;

  addTorrent(source: IntakeSource, options: AddTorrentOptions): Promise<TorrentHandle>;

  /** ~1/s poll. Must expose raw telemetry; zero seeds/speed is NOT an error. */
  getProgress(handle: TorrentHandle): Promise<DownloadTelemetry>;

  /** Stop torrent activity (pause) once selected files complete. */
  stop(handle: TorrentHandle): Promise<void>;

  /** Guarded delete of an owned torrent, optionally with its data. */
  deleteOwned(handle: TorrentHandle, deleteData: boolean): Promise<void>;
}

/** One explicitly selected file handed to the packaging adapter. */
export interface PackageEntry {
  /** Absolute path of the completed file inside this job's download root. */
  absoluteSourcePath: string;
  /** Logical torrent-relative path preserved inside the archive. */
  archiveRelativePath: string;
  /** Declared size from torrent metadata (validated against lstat). */
  sizeBytes: number;
  torrentFileIndex?: number;
}

/** Renderer-facing packaging progress (structural mirror of A4's payload). */
export interface PackagingProgressView {
  processedBytes: number;
  totalBytes: number;
  /** 0..1 */
  progress: number;
  throughputBytesPerSecond: number;
  filesCompleted: number;
  filesTotal: number;
}

export interface ZipRequest {
  entries: PackageEntry[];
  outputZipPath: string;
  abort: AbortSignal;
  onProgress?: (progress: PackagingProgressView) => void;
}

export interface PackageResult {
  zipPath: string;
  sizeBytes: number;
}

export interface PackagingGateway {
  createZip(request: ZipRequest): Promise<PackageResult>;
}

/** Renderer-facing upload progress (structural mirror of A3's payload). */
export interface UploadProgressView {
  uploadedBytes: number;
  totalBytes: number;
  /** 0..1 */
  progress: number;
  speedBps: number;
  etaSeconds: number | null;
  completedParts?: number;
  totalParts?: number;
}

export interface UploadRequest {
  filePath: string;
  /** Suggested remote name (zip name or original single-file name). */
  fileName: string;
  sizeBytes: number | null;
  abort: AbortSignal;
  onProgress?: (progress: UploadProgressView) => void;
}

export interface VikingUploadResult {
  url: string;
  sha256?: string | null;
  sizeBytes?: number | null;
}

/**
 * Viking adapter surface. No undocumented abort API is assumed: cancellation
 * is cooperative via AbortSignal only.
 */
export interface VikingGateway {
  upload(request: UploadRequest): Promise<VikingUploadResult>;
  /** Optional capability: verify a previously returned result. */
  verify?(result: VikingUploadResult): Promise<boolean>;
}

export interface PreflightRequest {
  path: string;
  /** Legacy coarse peak (engine fallback when canonical inputs are absent). */
  requiredBytes: number;
  /** Legacy fixed reserve (ignored by adapters applying the canonical policy). */
  safetyReserveBytes: number;
  /** Canonical selection facts for the authoritative disk-space policy. */
  selectedBytes?: number;
  fileCount?: number;
  zipRequired?: boolean;
}

export interface PreflightVerdict {
  ok: boolean;
  freeBytes: number | null;
  reason?: string;
  /** Authoritative figures surfaced by adapters applying the canonical policy. */
  estimatedZipBytes?: number | null;
  safetyReserveBytes?: number | null;
  requiredPeakBytes?: number | null;
  deficitBytes?: number | null;
}

export interface LiveHeadroomRequest {
  path: string;
  /** Freshly sampled free bytes (null = unknown volume). */
  freeBytes: number | null;
  selectedTotalBytes: number;
  downloadedSelectedBytes: number;
  zipRequired: boolean;
  fileCount?: number;
}

/**
 * Storage adapter surface. Blocking semantics (pause/stop when unsafe) belong
 * to the adapter; the engine reacts to `statFreeBytes` + verdicts.
 * `liveHeadroom`/`evaluatePackagingStart` are optional canonical-policy
 * capabilities; the engine falls back to its coarse local math when absent.
 */
export interface StorageGateway {
  statFreeBytes(path: string): Promise<number | null>;
  preflight(request: PreflightRequest): Promise<PreflightVerdict>;
  liveHeadroom?(request: LiveHeadroomRequest): Promise<import("./types.ts").StorageView>;
  evaluatePackagingStart?(request: {
    path: string;
    selectedBytes: number;
    fileCount: number;
  }): Promise<{
    allowed: boolean;
    freeBytes: number | null;
    requiredAdditionalBytes: number | null;
    deficitBytes: number | null;
  }>;
}

/**
 * Tiny JSON-backed persistence. Implementations should write atomically
 * (tmp + rename) but this is NOT a crash-recovery engine.
 */
export interface JobRepository {
  loadAll(): Promise<import("./types.ts").JobRecord[]>;
  upsert(record: import("./types.ts").JobRecord): Promise<void>;
  get(id: string): Promise<import("./types.ts").JobRecord | null>;
  findByIdempotencyKey(key: string): Promise<import("./types.ts").JobRecord | null>;
}

/** Filesystem helper for per-job directories (injected so tests can use memory fakes). */
export interface WorkspaceGateway {
  /** Creates <root>/jobs/<jobId>/{download,package} and returns absolute paths. */
  createJobDirs(jobId: string): Promise<{ jobDir: string; downloadDir: string; packageDir: string }>;
  removePath(path: string): Promise<void>;
  join(...parts: string[]): string;
  pathExists(path: string): Promise<boolean>;
  /** Resolves a filename inside the job's download dir (creating the dir). */
  joinDownload(downloadDir: string, filename: string): Promise<string>;
  /** Size of an existing file in bytes. */
  statFile(path: string): Promise<{ sizeBytes: number }>;
}
