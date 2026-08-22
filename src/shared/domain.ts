import { z } from 'zod'

// ---------------------------------------------------------------------------
// Core enums
// ---------------------------------------------------------------------------

export const AppModeSchema = z.enum(['client', 'server'])
export type AppMode = z.infer<typeof AppModeSchema>

export const JobStateSchema = z.enum([
  'reading_metadata',
  'awaiting_selection',
  'queued',
  'downloading',
  'packaging',
  'uploading',
  'finalizing',
  'complete',
  'failed',
  'cancelled',
  'interrupted'
])
export type JobState = z.infer<typeof JobStateSchema>

/** True once a job has reached a state it will never leave on its own. */
export function isTerminalJobState(state: JobState): boolean {
  return (
    state === 'complete' ||
    state === 'failed' ||
    state === 'cancelled' ||
    state === 'interrupted'
  )
}

export const StageStateSchema = z.enum(['waiting', 'active', 'complete', 'failed', 'skipped'])
export type StageState = z.infer<typeof StageStateSchema>

// ---------------------------------------------------------------------------
// Torrent metadata (public /v1 shapes — qBittorrent file indexes are canonical)
// ---------------------------------------------------------------------------

export const TorrentFileEntrySchema = z.object({
  /** qBittorrent file index inside the torrent — canonical selection identity. */
  index: z.number().int().min(0),
  /** Relative path within the torrent (forward slashes). */
  path: z.string().min(1),
  sizeBytes: z.number().int().min(0)
})
export type TorrentFileEntry = z.infer<typeof TorrentFileEntrySchema>

export const TorrentMetadataSchema = z.object({
  name: z.string().min(1),
  infoHashV1: z.string().min(1).nullable().optional(),
  infoHashV2: z.string().min(1).nullable().optional(),
  files: z.array(TorrentFileEntrySchema),
  totalSizeBytes: z.number().int().min(0)
})
export type TorrentMetadata = z.infer<typeof TorrentMetadataSchema>

export const IntakeSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('magnet'), value: z.string().min(1) }),
  z.object({ kind: z.literal('url'), value: z.string().min(1) })
])
export type IntakeSource = z.infer<typeof IntakeSourceSchema>

/** Draft view while reading metadata / awaiting selection. */
export const IntakeDraftViewSchema = z.object({
  id: z.string().min(1),
  state: z.enum(['reading_metadata', 'awaiting_selection', 'failed']),
  metadata: TorrentMetadataSchema.nullable(),
  error: z.unknown().nullable()
})
export type IntakeDraftView = z.infer<typeof IntakeDraftViewSchema>

// ---------------------------------------------------------------------------
// Live progress payloads
// ---------------------------------------------------------------------------

export const DownloadTelemetrySchema = z.object({
  progressPct: z.number().min(0).max(100),
  downloadedBytes: z.number().int().min(0),
  totalSelectedBytes: z.number().int().min(0),
  speedBps: z.number().min(0),
  etaSeconds: z.number().int().min(0).nullable(),
  seeds: z.number().int().min(0),
  peers: z.number().int().min(0),
  /** True when every selected file has finished downloading. */
  selectedComplete: z.boolean(),
  at: z.number().int().min(0).optional()
})
export type DownloadTelemetry = z.infer<typeof DownloadTelemetrySchema>

export const PackagingProgressSchema = z.object({
  processedBytes: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
  /** 0..1 */
  progress: z.number().min(0).max(1),
  throughputBytesPerSecond: z.number().min(0),
  filesCompleted: z.number().int().min(0),
  filesTotal: z.number().int().min(0)
})
export type PackagingProgress = z.infer<typeof PackagingProgressSchema>

export const UploadProgressSchema = z.object({
  uploadedBytes: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
  /** 0..1 */
  progress: z.number().min(0).max(1),
  speedBps: z.number().min(0),
  etaSeconds: z.number().int().min(0).nullable(),
  completedParts: z.number().int().min(0).optional(),
  totalParts: z.number().int().min(1).optional()
})
export type UploadProgress = z.infer<typeof UploadProgressSchema>

// ---------------------------------------------------------------------------
// Storage (authoritative values computed server-side; renderers never do math)
// ---------------------------------------------------------------------------

export const StorageViewSchema = z.object({
  freeBytes: z.number().int().min(0).nullable(),
  remainingDownloadBytes: z.number().int().min(0).nullable(),
  zipReservationBytes: z.number().int().min(0).nullable(),
  safetyReserveBytes: z.number().int().min(0).nullable(),
  /** May be negative when space is insufficient; UI must handle that. */
  projectedHeadroomBytes: z.number().int().nullable(),
  /** 'low' => concerning; 'critical' => filesystem exhaustion imminent. */
  warning: z.enum(['none', 'low', 'critical'])
})
export type StorageView = z.infer<typeof StorageViewSchema>

export const PreflightViewSchema = z.object({
  selectedFiles: z.number().int().min(1),
  selectedBytes: z.number().int().min(0),
  /** Null when a single file is uploaded directly without packaging. */
  tempZipBytes: z.number().int().min(0).nullable(),
  safetyReserveBytes: z.number().int().min(0).nullable(),
  peakRequiredBytes: z.number().int().min(0).nullable(),
  serverFreeBytes: z.number().int().min(0).nullable(),
  enough: z.boolean(),
  missingBytes: z.number().int().min(0).nullable(),
  /** Server-side hard block; Start must be disabled when true. */
  blocked: z.boolean()
})
export type PreflightView = z.infer<typeof PreflightViewSchema>

// ---------------------------------------------------------------------------
// Job snapshot (public /v1 shape — mirrors the engine record minus local paths)
// ---------------------------------------------------------------------------

export const SpeedHintSchema = z.enum(['slow', 'waiting_for_peers']).nullable()
export type SpeedHint = z.infer<typeof SpeedHintSchema>

export const FailureKindSchema = z.enum([
  'metadata',
  'storage_preflight',
  'download',
  'storage_before_packaging',
  'packaging',
  'upload',
  'finalize'
])
export type FailureKind = z.infer<typeof FailureKindSchema>

export const JobErrorSchema = z.object({
  kind: FailureKindSchema,
  message: z.string().min(1),
  /** Set when the failure is specifically insufficient disk space. */
  insufficientSpace: z.boolean().optional()
})
export type JobError = z.infer<typeof JobErrorSchema>

export const JobResultSchema = z.object({
  /** Final Viking URL of the delivered artifact. */
  url: z.string().min(1),
  /** Upload hash reported by Viking (verification identity). */
  sha256: z.string().min(1).nullable().optional(),
  sizeBytes: z.number().int().min(0).nullable().optional(),
  /** Present when upload succeeded and the URL was durably saved but local cleanup failed. */
  cleanupWarning: z.string().nullable().optional(),
  /** check-file verification outcome; null/absent = not verified (never fails the job). */
  verified: z.boolean().nullable().optional()
})
export type JobResult = z.infer<typeof JobResultSchema>

export const StageMapSchema = z.record(z.string(), StageStateSchema)
export type StageMap = z.infer<typeof StageMapSchema>

/**
 * Authoritative job snapshot as served by the relay REST API. Server-local
 * filesystem paths (job/download/package dirs, archive paths, source paths)
 * are intentionally NOT part of this public contract.
 */
export const JobSnapshotSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  state: JobStateSchema,

  source: IntakeSourceSchema,
  selection: z.array(z.number().int().min(0)).nullable().optional(),
  selectedBytes: z.number().int().min(0).nullable().optional(),
  zipRequired: z.boolean().nullable().optional(),

  metadata: TorrentMetadataSchema.nullable().optional(),
  stages: StageMapSchema,
  telemetry: DownloadTelemetrySchema.nullable().optional(),
  storage: StorageViewSchema.nullable().optional(),
  hint: SpeedHintSchema.optional(),

  packagingProgress: PackagingProgressSchema.nullable().optional(),
  uploadProgress: UploadProgressSchema.nullable().optional(),
  preflight: PreflightViewSchema.nullable().optional(),

  result: JobResultSchema.nullable().optional(),
  error: JobErrorSchema.nullable().optional(),
  lastKnownStage: z.string().min(1).nullable().optional()
})
export type JobSnapshot = z.infer<typeof JobSnapshotSchema>
