/**
 * Viking Relay — A5 job engine shared types.
 * Pure types + state constants only. No runtime dependencies.
 */

export const JOB_STATES = [
  "reading_metadata",
  "awaiting_selection",
  "queued",
  "downloading",
  "packaging",
  "uploading",
  "finalizing",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_JOB_STATES: readonly JobState[] = [
  "complete",
  "failed",
  "cancelled",
  "interrupted",
];
export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(state);
}

export const STAGE_NAMES = [
  "metadata",
  "selection",
  "preflight",
  "download",
  "packaging",
  "upload",
  "finalize",
  "cleanup",
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export const STAGE_STATES = ["waiting", "active", "complete", "failed", "skipped"] as const;
export type StageState = (typeof STAGE_STATES)[number];

export type StageMap = Record<StageName, StageState>;

export function initialStageMap(): StageMap {
  return {
    metadata: "waiting",
    selection: "waiting",
    preflight: "waiting",
    download: "waiting",
    packaging: "waiting",
    upload: "waiting",
    finalize: "waiting",
    cleanup: "waiting",
  };
}

/** Where the torrent source came from. */
export type IntakeSource =
  | { kind: "magnet"; value: string }
  | { kind: "url"; value: string }
  | { kind: "direct"; value: string };

export interface TorrentFileEntry {
  /** qBittorrent file index inside the torrent. */
  index: number;
  /** Relative path within the torrent (forward slashes). */
  path: string;
  sizeBytes: number;
}

export interface TorrentMetadataInfo {
  name: string;
  infoHashV1?: string | null;
  infoHashV2?: string | null;
  files: TorrentFileEntry[];
  totalSizeBytes: number;
}

/** Live telemetry polled from the torrent gateway (~1/s). */
export interface DownloadTelemetry {
  progressPct: number;
  downloadedBytes: number;
  totalSelectedBytes: number;
  speedBps: number;
  etaSeconds: number | null;
  seeds: number;
  peers: number;
  /** True when every selected file has finished downloading. */
  selectedComplete: boolean;
  /**
   * Adapter-provided absolute paths for the SELECTED files, present once they
   * are complete. Adapters know their own layout (single-file torrents land
   * directly in outputDir; multi-file ones nest under the torrent name).
   */
  selectedFiles?: Array<{ index: number; absolutePath: string }> | null;
  at?: number;
}

/** Storage view surfaced during download/packaging. Deliberately coarse. */
export interface StorageView {
  freeBytes: number | null;
  remainingDownloadBytes: number | null;
  zipReservationBytes: number | null;
  safetyReserveBytes: number | null;
  projectedHeadroomBytes: number | null;
  /** 'low' => concerning; 'critical' => filesystem exhaustion imminent. */
  warning: "none" | "low" | "critical";
}

export type SpeedHint = "slow" | "waiting_for_peers" | null;

/** Authoritative pre-Start storage verdict surfaced to renderers. */
export interface PreflightView {
  selectedFiles: number;
  selectedBytes: number;
  /** Null when a single file is uploaded directly without packaging. */
  tempZipBytes: number | null;
  safetyReserveBytes: number | null;
  peakRequiredBytes: number | null;
  serverFreeBytes: number | null;
  enough: boolean;
  missingBytes: number | null;
  /** Server-side hard block; Start must be disabled when true. */
  blocked: boolean;
}

export type FailureKind =
  | "metadata"
  | "storage_preflight"
  | "download"
  | "storage_before_packaging"
  | "packaging"
  | "upload"
  | "finalize";

export interface JobError {
  kind: FailureKind;
  message: string;
  /** Set when the failure is specifically insufficient disk space. */
  insufficientSpace?: boolean;
}

export interface JobResult {
  /** Viking URL of the delivered artifact. Persisted BEFORE destructive cleanup. */
  url: string;
  /** Direct download link resolved from the provider, when available. */
  directUrl?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
  /** Present when upload succeeded and final URL was durably saved but local cleanup failed. */
  cleanupWarning?: string | null;
  verified?: boolean | null;
}

/** What gets cleaned up after a successful upload (global defaults + per-job overrides). */
export interface CleanupPolicy {
  deleteTorrent: boolean;
  deleteFiles: boolean;
  deleteZip: boolean;
}

/** Full persisted/exposed job record. Kept intentionally small (JSON-backed). */
export interface JobRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  state: JobState;

  source: IntakeSource;
  /** Idempotency key bound at intake time (optional). */
  idempotencyKey?: string | null;
  /** Idempotency key bound at Start/commit time (optional, separate scope). */
  startIdempotencyKey?: string | null;

  metadata?: TorrentMetadataInfo | null;
  selection?: number[] | null;
  selectedBytes?: number | null;
  zipRequired?: boolean | null;

  stages: StageMap;
  telemetry?: DownloadTelemetry | null;
  storage?: StorageView | null;
  hint?: SpeedHint;

  /** Live packaging progress while state === 'packaging' (optional). */
  packagingProgress?: import("./gateways.ts").PackagingProgressView | null;
  /** Live upload progress while state === 'uploading' (optional). */
  uploadProgress?: import("./gateways.ts").UploadProgressView | null;
  /** Authoritative pre-Start storage verdict (set at commit time). */
  preflight?: PreflightView | null;

  /** Resolved cleanup policy (defaults + per-job overrides), set at commit time. */
  cleanupPolicy?: CleanupPolicy | null;

  result?: JobResult | null;
  error?: JobError | null;
  /** Last known stage when a previous-session job was marked interrupted. */
  lastKnownStage?: StageName | null;

  /** User acknowledged the interrupted-job banner (UI persistence only). */
  dismissed?: boolean | null;

  /** Archived jobs are hidden from the default history view. */
  archived?: boolean;

  /** Engine session epoch that created/last touched this job. Used by the startup sweep. */
  sessionEpoch?: string | null;

  /** Absolute paths for this job's workspace (set once committed). */
  jobDir?: string | null;
  downloadDir?: string | null;
  packageDir?: string | null;
  zipPath?: string | null;
  /** Exact single-file source used when packaging is skipped. */
  directSourcePath?: string | null;
  /** Opaque torrent id from the gateway, persisted for later guarded deletion. */
  torrentId?: string | null;
  /** Absolute paths of completed selected files (persisted for retry paths). */
  completedFiles?: Array<{ index: number; absolutePath: string }> | null;
}

/** REST-facing snapshot helpers ------------------------------------------------ */

export interface IntakeDraftView {
  id: string;
  state: Extract<JobState, "reading_metadata" | "awaiting_selection" | "failed">;
  metadata: TorrentMetadataInfo | null;
  error: JobError | null;
}
