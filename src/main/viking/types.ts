/**
 * Viking (vikingfile.com) "fast" multipart upload API — internal types.
 *
 * Source of truth: https://vikingfile.com/api (official documentation).
 * Shared project contracts were not available at implementation time;
 * these types are INTERNAL to the Viking integration and must be adapted
 * (not duplicated) once src/shared contracts land.
 */

/** A local source file to upload. The file is only ever READ. */
export interface UploadSourceFile {
  /** Absolute path on disk. Never mutated by this module. */
  path: string
  /** Size in bytes (from fs.stat; must match reality). */
  size: number
  /** File name submitted as `name` to complete-upload. */
  name: string
}

export type VikingLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface VikingLogger {
  debug?(message: string, meta?: Record<string, unknown>): void
  info?(message: string, meta?: Record<string, unknown>): void
  warn?(message: string, meta?: Record<string, unknown>): void
  error?(message: string, meta?: Record<string, unknown>): void
}

export interface VikingBackoffOptions {
  /** Delay before first retry. Default 500ms. */
  baseDelayMs?: number
  /** Upper bound for a single backoff sleep. Default 15000ms. */
  maxDelayMs?: number
  /** Total attempts per request (initial try included). Default 4. */
  maxAttempts?: number
}

export interface VikingClientOptions {
  /**
   * API origin. Default: https://vikingfile.com
   * Tests point this at a local mock server.
   */
  baseUrl?: string
  /**
   * Account identity ("user's hash"). Empty/undefined uploads anonymously.
   * The official API documents `user` as required-but-may-be-empty.
   * Must never leave the main process or appear in logs.
   */
  userHash?: string
  /**
   * Per-request stall timeout in ms: aborts a request that makes no
   * progress (no bytes written, no response bytes) for this long.
   * Default 60000.
   */
  timeoutMs?: number
  /**
   * Simultaneous part uploads. Default 3.
   */
  concurrency?: number
  backoff?: VikingBackoffOptions
  logger?: VikingLogger
}

/** Response of POST /api/get-upload-url, strictly validated. */
export interface VikingMultipartSession {
  uploadId: string
  key: string
  partSize: number
  numberParts: number
  /** Signed PUT URLs, index i corresponds to partNumber i+1. */
  urls: string[]
}

/** One successfully uploaded part, ready for complete-upload. */
export interface CompletedPart {
  partNumber: number
  /** ETag exactly as returned by the server (header value, verbatim). */
  etag: string
}

export interface CompleteUploadInfo {
  name: string
  /** Optional remote folder path, e.g. "Folder/My sub folder". */
  path?: string
  /** Optional public-share path token from vikingfile.com/public-upload/<token>. */
  pathPublicShare?: string
}

/** Response of POST /api/complete-upload. */
export interface VikingUploadResult {
  url: string
  hash: string
  name: string
  size?: number
}

/** Result of POST /api/check-file. */
export interface VikingFileCheck {
  exists: boolean
  name?: string
  size?: number
}

export interface UploadProgress {
  /** Bytes confirmed written toward parts that have not failed. */
  uploadedBytes: number
  totalBytes: number
  /** 0..1 — counts actual transmitted bytes, not started parts. */
  progress: number
  /** Rolling average over the recent window, bytes/sec. */
  bytesPerSecond: number
  /** Estimated seconds remaining at current speed; null when unknown. */
  etaSeconds: number | null
  completedParts: number
  totalParts: number
}

export interface UploadFileOptions {
  signal?: AbortSignal
  onProgress?: (progress: UploadProgress) => void
  /** Throttle for onProgress callbacks. Default 100ms. */
  progressIntervalMs?: number
  /** Override client-level concurrency for this upload. */
  concurrency?: number
  /** Verify via check-file before returning (default false). */
  verify?: boolean
  path?: string
  pathPublicShare?: string
}
