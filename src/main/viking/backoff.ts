import type { VikingBackoffOptions } from './types'

/**
 * Bounded exponential backoff with full jitter.
 * Transient only: connection resets, timeouts, HTTP 408/429/5xx.
 * Permanent 4xx never reaches this module (classified non-retryable upstream).
 */

export const DEFAULT_BACKOFF: Required<VikingBackoffOptions> = {
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  maxAttempts: 4,
}

export function resolveBackoff(options?: VikingBackoffOptions): Required<VikingBackoffOptions> {
  return { ...DEFAULT_BACKOFF, ...options }
}

/** Full jitter: uniform in [0, min(maxDelay, base * 2^attempt)]. attempt is 0-based. */
export function computeBackoffDelay(attempt: number, opts: Required<VikingBackoffOptions>): number {
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** Math.max(0, attempt))
  return Math.floor(Math.random() * exp)
}

const TRANSIENT_STATUS = new Set([408, 429])

export function isTransientHttpStatus(status: number): boolean {
  return TRANSIENT_STATUS.has(status) || (status >= 500 && status <= 599)
}

export function parseRetryAfterMs(headerValue: string | string[] | undefined): number | null {
  if (!headerValue) return null
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000)
  const date = Date.parse(raw)
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 60_000))
  return null
}

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
