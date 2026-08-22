/**
 * Viking Relay — Client Mode renderer domain types (A7).
 *
 * INTEGRATION SEAM: these mirror `src/main/jobs/types.ts` (A5) and the shared
 * contracts being defined by other lanes. When `src/shared/**` lands, replace
 * this file's re-exports with imports from the shared module. Nothing outside
 * this directory should import from here.
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

export type StageName =
  | "metadata"
  | "selection"
  | "preflight"
  | "download"
  | "packaging"
  | "upload"
  | "finalize"
  | "cleanup";

export const STAGE_STATES = ["waiting", "active", "complete", "failed", "skipped"] as const;
export type StageState = (typeof STAGE_STATES)[number];
export type StageMap = Record<StageName, StageState>;

export type IntakeSource =
  | { kind: "magnet"; value: string }
  | { kind: "url"; value: string };

export interface TorrentFileEntry {
  index: number;
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

export interface DownloadTelemetry {
  progressPct: number;
  downloadedBytes: number;
  totalSelectedBytes: number;
  speedBps: number;
  etaSeconds: number | null;
  seeds: number;
  peers: number;
  selectedComplete: boolean;
  at?: number;
}

export interface StorageView {
  freeBytes: number | null;
  remainingDownloadBytes: number | null;
  zipReservationBytes: number | null;
  safetyReserveBytes: number | null;
  projectedHeadroomBytes: number | null;
  warning: "none" | "low" | "critical";
}

export type SpeedHint = "slow" | "waiting_for_peers" | null;

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
  insufficientSpace?: boolean;
}

export interface JobResult {
  url: string;
  /** Direct download link resolved by the server, when available. */
  directUrl?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
  cleanupWarning?: string | null;
  verified?: boolean | null;
}

export interface JobRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  state: JobState;

  source: IntakeSource;
  idempotencyKey?: string | null;

  metadata?: TorrentMetadataInfo | null;
  selection?: number[] | null;
  selectedBytes?: number | null;
  zipRequired?: boolean | null;

  stages: StageMap;
  telemetry?: DownloadTelemetry | null;
  storage?: StorageView | null;
  hint?: SpeedHint;

  result?: JobResult | null;
  error?: JobError | null;
  lastKnownStage?: StageName | null;

  sessionEpoch?: string | null;

  jobDir?: string | null;
  downloadDir?: string | null;
  packageDir?: string | null;
  zipPath?: string | null;
  directSourcePath?: string | null;
}

/** Draft view while reading metadata / awaiting selection. */
export interface IntakeDraftView {
  id: string;
  state: Extract<JobState, "reading_metadata" | "awaiting_selection" | "failed">;
  metadata: TorrentMetadataInfo | null;
  error: JobError | null;
}

/**
 * Authoritative storage preflight returned by the server after selection is
 * confirmed. The renderer NEVER computes disk math itself; it renders these
 * values verbatim.
 */
export interface StoragePreflight {
  selectedFiles: number;
  selectedBytes: number;
  /** Null when a single file is uploaded directly without packaging. */
  tempZipBytes: number | null;
  safetyReserveBytes: number;
  peakRequiredBytes: number;
  /** Null when the server could not stat the volume (unknown, not blocked). */
  serverFreeBytes: number | null;
  enough: boolean;
  missingBytes?: number | null;
  /** Server-side hard block; Start must be disabled when true. */
  blocked?: boolean;
}

/** Packaging progress, exposed by the server while state === 'packaging'. */
export interface PackagingProgress {
  processedFiles: number;
  totalFiles: number;
  progressPct: number;
  throughputBps: number | null;
  freeBytes: number | null;
}

/** Viking upload progress, exposed by the server while state === 'uploading'. */
export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  progressPct: number;
  throughputBps: number | null;
  etaSeconds: number | null;
  partCount?: number | null;
}

/**
 * Extended job snapshot: A5 JobRecord plus live stage detail. The server may
 * attach packaging/upload progress to the polled record; both are optional so
 * the renderer degrades gracefully during integration.
 */
export interface JobSnapshot extends JobRecord {
  packagingProgress?: PackagingProgress | null;
  uploadProgress?: UploadProgress | null;
}

export interface HistoryEntry {
  id: string;
  name: string;
  state: JobState;
  sizeBytes: number | null;
  completedAt: string | null;
  url: string | null;
}
