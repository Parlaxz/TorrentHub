import fs from 'node:fs'
import type { Readable } from 'node:stream'

import {
  computeBackoffDelay,
  isTransientHttpStatus,
  parseRetryAfterMs,
  resolveBackoff,
  sleepWithAbort,
} from './backoff'
import { VikingError } from './errors'
import {
  HttpAbortedError,
  HttpStallTimeoutError,
  httpRequest,
  isTransientTransportError,
  sanitizeUrl,
} from './http'
import { buildProgress, RollingSpeedTracker } from './progress'
import type {
  CompletedPart,
  CompleteUploadInfo,
  UploadFileOptions,
  UploadSourceFile,
  VikingClientOptions,
  VikingFileCheck,
  VikingLogger,
  VikingMultipartSession,
  VikingUploadResult,
} from './types'

export const DEFAULT_CONCURRENCY = 3

/** Computes 0-based [start, end] byte ranges (end inclusive) for each part. */
export function computeParts(size: number, partSize: number): Array<{ start: number; end: number }> {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new VikingError({ kind: 'invalid_input', message: `Invalid file size: ${size}`, retryable: false })
  }
  if (!Number.isSafeInteger(partSize) || partSize <= 0) {
    throw new VikingError({ kind: 'invalid_input', message: `Invalid part size: ${partSize}`, retryable: false })
  }
  const parts: Array<{ start: number; end: number }> = []
  for (let start = 0; start < size; start += partSize) {
    parts.push({ start, end: Math.min(start + partSize, size) - 1 })
  }
  return parts
}

function snippet(body: Buffer): string {
  return body.subarray(0, 200).toString('utf8')
}

function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8').replace(/^\uFEFF/, '')
  try {
    return JSON.parse(text)
  } catch {
    throw new VikingError({
      kind: 'malformed_response',
      message: 'Viking API returned a non-JSON body',
      retryable: false,
      bodySnippet: text.slice(0, 200),
    })
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new VikingError({
      kind: 'malformed_response',
      message: `Viking API response field "${field}" is missing or not a non-empty string`,
      retryable: false,
    })
  }
  return value
}

export class VikingClient {
  readonly concurrency: number
  private readonly baseUrl: string
  private readonly userHash: string
  private readonly timeoutMs: number
  private readonly backoff: ReturnType<typeof resolveBackoff>
  private readonly logger: VikingLogger | undefined

  constructor(options: VikingClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://vikingfile.com').replace(/\/+$/, '')
    this.userHash = options.userHash ?? ''
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY))
    this.backoff = resolveBackoff(options.backoff)
    this.logger = options.logger
  }

  // ------------------------------------------------------------------
  // Low-level API helpers
  // ------------------------------------------------------------------

  private redact(text: string): string {
    if (this.userHash && text.includes(this.userHash)) {
      return text.split(this.userHash).join('***')
    }
    return text
  }

  private wrapTransportError(error: unknown, context: string): VikingError {
    if (error instanceof HttpStallTimeoutError) {
      return new VikingError({
        kind: 'timeout',
        message: `${context}: stalled (${sanitizeUrl(error.url)})`,
        retryable: true,
        cause: error,
      })
    }
    if (error instanceof HttpAbortedError) {
      return new VikingError({ kind: 'aborted', message: `${context}: aborted`, retryable: false, cause: error })
    }
    const err = error as NodeJS.ErrnoException
    if (err && typeof err === 'object' && isTransientTransportError(err)) {
      return new VikingError({
        kind: 'network',
        message: `${context}: ${err.code ?? err.message}`,
        retryable: true,
        cause: err,
      })
    }
    return new VikingError({
      kind: 'network',
      message: `${context}: ${err?.message ?? String(error)}`,
      retryable: false,
      cause: err,
    })
  }

  private async postForm(
    endpoint: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ status: number; json: unknown }> {
    const body = new URLSearchParams(params).toString()
    let res
    try {
      res = await httpRequest({
        method: 'POST',
        url: `${this.baseUrl}/api/${endpoint}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': String(Buffer.byteLength(body)),
        },
        body,
        timeoutMs: this.timeoutMs,
        signal,
      })
    } catch (error) {
      throw this.wrapTransportError(error, `${endpoint} request failed`)
    }
    if (res.status < 200 || res.status > 299) {
      const jsonAttempt = safeJson(res.body)
      const apiMessage =
        jsonAttempt && typeof jsonAttempt === 'object' && typeof (jsonAttempt as { error?: unknown }).error === 'string'
          ? (jsonAttempt as { error: string }).error
          : undefined
      throw new VikingError({
        kind: 'http_status',
        message: `${endpoint} failed with HTTP ${res.status}${apiMessage ? `: ${apiMessage}` : ''}`,
        statusCode: res.status,
        retryable: isTransientHttpStatus(res.status),
        retryAfterMs: parseRetryAfterMs(res.headers['retry-after']) ?? undefined,
        bodySnippet: this.redact(snippet(res.body)),
      })
    }
    return { status: res.status, json: parseJsonBody(res.body) }
  }

  /** postForm + bounded transient retry (network/timeout/408/429/5xx). */
  private async postFormWithRetry(
    endpoint: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ status: number; json: unknown }> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.postForm(endpoint, params, signal)
      } catch (error) {
        const ve = error instanceof VikingError ? error : this.wrapTransportError(error, endpoint)
        if (ve.kind === 'aborted' || !ve.retryable || attempt >= this.backoff.maxAttempts) throw ve
        const delay = ve.retryAfterMs ?? computeBackoffDelay(attempt - 1, this.backoff)
        this.logger?.warn?.('viking: retrying api call', { endpoint, attempt, delayMs: delay, kind: ve.kind })
        try {
          await sleepWithAbort(delay, signal)
        } catch {
          throw new VikingError({ kind: 'aborted', message: `Cancelled during ${endpoint} retry backoff`, retryable: false })
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 1. Session creation — POST /api/get-upload-url
  // ------------------------------------------------------------------

  async createMultipartSession(
    file: UploadSourceFile,
    opts: { signal?: AbortSignal } = {},
  ): Promise<VikingMultipartSession> {
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new VikingError({ kind: 'invalid_input', message: `Invalid source size: ${file.size}`, retryable: false })
    }
    const { json } = await this.postFormWithRetry('get-upload-url', { size: String(file.size) }, opts.signal)
    const raw = json as Record<string, unknown> | null
    if (!raw || typeof raw !== 'object') {
      throw new VikingError({
        kind: 'malformed_response',
        message: 'get-upload-url response is not an object',
        retryable: false,
      })
    }
    const uploadId = requireString(raw.uploadId, 'uploadId')
    const key = requireString(raw.key, 'key')
    const partSize = raw.partSize
    const numberParts = raw.numberParts
    const urls = raw.urls
    if (typeof partSize !== 'number' || !Number.isSafeInteger(partSize) || partSize <= 0) {
      throw new VikingError({
        kind: 'malformed_response',
        message: `get-upload-url returned invalid partSize: ${String(partSize)}`,
        retryable: false,
      })
    }
    if (typeof numberParts !== 'number' || !Number.isSafeInteger(numberParts) || numberParts <= 0) {
      throw new VikingError({
        kind: 'malformed_response',
        message: `get-upload-url returned invalid numberParts: ${String(numberParts)}`,
        retryable: false,
      })
    }
    if (!Array.isArray(urls) || urls.length !== numberParts) {
      throw new VikingError({
        kind: 'malformed_response',
        message: `get-upload-url returned ${Array.isArray(urls) ? urls.length : 'no'} urls for numberParts=${numberParts}`,
        retryable: false,
      })
    }
    for (const url of urls) {
      if (typeof url !== 'string') {
        throw new VikingError({ kind: 'malformed_response', message: 'get-upload-url returned a non-string url', retryable: false })
      }
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('bad protocol')
      } catch {
        throw new VikingError({
          kind: 'malformed_response',
          message: `get-upload-url returned an invalid url: ${this.redact(sanitizeUrl(String(url)))}`,
          retryable: false,
        })
      }
    }
    const expectedParts = Math.ceil(file.size / partSize)
    if (expectedParts !== numberParts) {
      this.logger?.warn?.('viking: server part count differs from ceil(size/partSize)', {
        expectedParts,
        numberParts,
      })
    }
    return { uploadId, key, partSize, numberParts, urls: urls as string[] }
  }

  // ------------------------------------------------------------------
  // 2. Part uploads — PUT each signed URL with a bounded byte range
  // ------------------------------------------------------------------

  async uploadParts(
    session: VikingMultipartSession,
    file: UploadSourceFile,
    opts: Pick<UploadFileOptions, 'signal' | 'onProgress' | 'progressIntervalMs' | 'concurrency'> = {},
  ): Promise<CompletedPart[]> {
    const signal = opts.signal
    const ranges = computeParts(file.size, session.partSize)
    if (ranges.length !== session.urls.length) {
      throw new VikingError({
        kind: 'malformed_response',
        message: `session inconsistency: ${session.urls.length} signed urls but ${ranges.length} byte ranges for size=${file.size}, partSize=${session.partSize}`,
        retryable: false,
      })
    }
    const totalParts = session.urls.length
    const concurrency = Math.max(1, Math.floor(opts.concurrency ?? this.concurrency))
    const tracker = new RollingSpeedTracker()
    const state = { uploadedBytes: 0, completedParts: 0 }
    let lastEmit = 0
    const progressIntervalMs = opts.progressIntervalMs ?? 100

    const emit = (force: boolean): void => {
      if (!opts.onProgress) return
      const now = Date.now()
      if (!force && now - lastEmit < progressIntervalMs) return
      lastEmit = now
      tracker.sample(state.uploadedBytes, now)
      opts.onProgress(buildProgress({ ...state, totalBytes: file.size, totalParts, tracker }))
    }

    const uploadOnePart = async (partIndex: number): Promise<CompletedPart> => {
      const partNumber = partIndex + 1
      const range = ranges[partIndex]
      const length = range.end - range.start + 1
      let attempt = 0
      for (;;) {
        attempt += 1
        const writtenThisAttempt = { bytes: 0 }
        try {
          const stream = fs.createReadStream(file.path, {
            start: range.start,
            end: range.end,
            autoClose: true,
          })
          const startedAt = Date.now()
          const res = await httpRequest({
            method: 'PUT',
            url: session.urls[partIndex],
            headers: { 'Content-Length': String(length) },
            bodyStream: stream as Readable,
            contentLength: length,
            timeoutMs: this.timeoutMs,
            signal,
            onBytesWritten: (n) => {
              writtenThisAttempt.bytes += n
              state.uploadedBytes += n
              emit(false)
            },
          })
          if (res.status < 200 || res.status > 299) {
            throw new VikingError({
              kind: 'http_status',
              message: `part ${partNumber} failed with HTTP ${res.status}`,
              statusCode: res.status,
              retryable: isTransientHttpStatus(res.status),
              retryAfterMs: parseRetryAfterMs(res.headers['retry-after']) ?? undefined,
              partNumber,
              attempt,
              bodySnippet: this.redact(snippet(res.body)),
            })
          }
          const etagHeader = res.headers.etag
          const etag = Array.isArray(etagHeader) ? etagHeader[0] : etagHeader
          if (!etag) {
            throw new VikingError({
              kind: 'malformed_response',
              message: `part ${partNumber} response carried no ETag header`,
              retryable: true,
              partNumber,
              attempt,
            })
          }
          state.completedParts += 1
          emit(true)
          this.logger?.debug?.('viking: part uploaded', {
            partNumber,
            attempt,
            bytes: length,
            ms: Date.now() - startedAt,
          })
          return { partNumber, etag }
        } catch (error) {
          state.uploadedBytes -= writtenThisAttempt.bytes
          const ve =
            error instanceof VikingError
              ? error
              : this.wrapTransportError(error, `part ${partNumber} failed`)
          if (ve.kind === 'aborted') throw ve
          if (!ve.retryable || attempt >= this.backoff.maxAttempts) {
            throw ve.attempt === undefined
              ? new VikingError({ ...veToDetails(ve), attempt })
              : ve
          }
          const delay = ve.retryAfterMs ?? computeBackoffDelay(attempt - 1, this.backoff)
          this.logger?.warn?.('viking: retrying part', {
            partNumber,
            attempt,
            delayMs: delay,
            kind: ve.kind,
            statusCode: ve.statusCode ?? null,
          })
          try {
            await sleepWithAbort(delay, signal)
          } catch {
            throw new VikingError({ kind: 'aborted', message: 'Upload cancelled during retry backoff', retryable: false })
          }
        }
      }
    }

    // Bounded worker pool over part indices.
    let nextIndex = 0
    const results: CompletedPart[] = new Array(totalParts)
    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal?.aborted) throw new VikingError({ kind: 'aborted', message: 'Upload cancelled', retryable: false })
        const index = nextIndex
        nextIndex += 1
        if (index >= totalParts) return
        results[index] = await uploadOnePart(index)
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, totalParts) }, () => worker())
    await Promise.all(workers)
    emit(true)
    return results
  }

  // ------------------------------------------------------------------
  // 3. Completion — POST /api/complete-upload
  // ------------------------------------------------------------------

  async completeMultipart(
    session: VikingMultipartSession,
    parts: CompletedPart[],
    info: CompleteUploadInfo,
    opts: { signal?: AbortSignal } = {},
  ): Promise<VikingUploadResult> {
    if (parts.length !== session.numberParts) {
      throw new VikingError({
        kind: 'invalid_input',
        message: `completeMultipart expected ${session.numberParts} parts, got ${parts.length}`,
        retryable: false,
      })
    }
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber)
    const params: Record<string, string> = {
      key: session.key,
      uploadId: session.uploadId,
      name: info.name,
      user: this.userHash,
    }
    sorted.forEach((part, i) => {
      params[`parts[${i}][PartNumber]`] = String(part.partNumber)
      params[`parts[${i}][ETag]`] = part.etag
    })
    if (info.path !== undefined) params.path = info.path
    if (info.pathPublicShare !== undefined) params.pathPublicShare = info.pathPublicShare

    const { json } = await this.postFormWithRetry('complete-upload', params, opts.signal)
    const raw = json as Record<string, unknown> | null
    if (!raw || typeof raw !== 'object') {
      throw new VikingError({ kind: 'malformed_response', message: 'complete-upload response is not an object', retryable: false })
    }
    const url = requireString(raw.url, 'url')
    const hash = requireString(raw.hash, 'hash')
    const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : info.name
    const size = typeof raw.size === 'number' && Number.isFinite(raw.size) ? raw.size : undefined
    return { url, hash, name, ...(size !== undefined ? { size } : {}) }
  }

  // ------------------------------------------------------------------
  // 4. Verification — POST /api/check-file (documented)
  // ------------------------------------------------------------------

  async verifyUploadedFile(
    hash: string,
    opts: { signal?: AbortSignal; expectedSize?: number } = {},
  ): Promise<VikingFileCheck> {
    if (typeof hash !== 'string' || hash.length === 0) {
      throw new VikingError({ kind: 'invalid_input', message: 'verifyUploadedFile requires a hash', retryable: false })
    }
    const { json } = await this.postFormWithRetry('check-file', { hash }, opts.signal)
    const raw = json as Record<string, unknown> | null
    if (!raw || typeof raw !== 'object' || typeof raw.exist !== 'boolean') {
      throw new VikingError({
        kind: 'malformed_response',
        message: 'check-file response did not contain an "exist" boolean',
        retryable: false,
        bodySnippet: raw ? undefined : snippet(Buffer.from(JSON.stringify(json ?? ''))),
      })
    }
    const result: VikingFileCheck = { exists: raw.exist }
    if (typeof raw.name === 'string') result.name = raw.name
    if (typeof raw.size === 'number' && Number.isFinite(raw.size)) result.size = raw.size
    if (opts.expectedSize !== undefined && result.exists && result.size !== opts.expectedSize) {
      throw new VikingError({
        kind: 'verification_failed',
        message: `check-file size mismatch: remote ${result.size}, local ${opts.expectedSize}`,
        retryable: false,
      })
    }
    return result
  }

  // ------------------------------------------------------------------
  // Convenience orchestration
  // ------------------------------------------------------------------

  async uploadFile(file: UploadSourceFile, opts: UploadFileOptions = {}): Promise<VikingUploadResult> {
    const signal = opts.signal
    const session = await this.createMultipartSession(file, { signal })
    const parts = await this.uploadParts(session, file, {
      signal,
      onProgress: opts.onProgress,
      progressIntervalMs: opts.progressIntervalMs,
      concurrency: opts.concurrency,
    })
    const result = await this.completeMultipart(
      session,
      parts,
      { name: file.name, path: opts.path, pathPublicShare: opts.pathPublicShare },
      { signal },
    )
    if (opts.verify) {
      await this.verifyUploadedFile(result.hash, { signal, expectedSize: file.size })
    }
    return result
  }
}

function veToDetails(ve: VikingError) {
  return {
    kind: ve.kind,
    message: ve.message,
    statusCode: ve.statusCode,
    retryable: ve.retryable,
    partNumber: ve.partNumber,
    bodySnippet: ve.bodySnippet,
    cause: ve.cause,
  }
}

function safeJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8').replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}
