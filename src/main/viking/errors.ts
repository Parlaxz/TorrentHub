/** Structured errors for the Viking integration. UI maps `kind` to actions like "Retry Upload". */

export type VikingErrorKind =
  | 'invalid_input'
  | 'malformed_response'
  | 'network'
  | 'timeout'
  | 'http_status'
  | 'aborted'
  | 'verification_failed'

export interface VikingErrorDetails {
  kind: VikingErrorKind
  message: string
  /** HTTP status when the error came from a response. */
  statusCode?: number
  /** True when the caller may retry the same operation. */
  retryable: boolean
  /** 1-based part number for part-level failures. */
  partNumber?: number
  /** Attempt number (1-based) on which the failure happened. */
  attempt?: number
  /** Truncated, sanitized response body snippet when available. */
  bodySnippet?: string
  /** Server-advised delay (Retry-After) when present. */
  retryAfterMs?: number
  cause?: unknown
}

export class VikingError extends Error {
  readonly kind: VikingErrorKind
  readonly retryable: boolean
  readonly statusCode?: number
  readonly partNumber?: number
  readonly attempt?: number
  readonly bodySnippet?: string
  readonly retryAfterMs?: number

  constructor(details: VikingErrorDetails) {
    super(details.message)
    this.name = 'VikingError'
    this.kind = details.kind
    this.retryable = details.retryable
    if (details.statusCode !== undefined) this.statusCode = details.statusCode
    if (details.partNumber !== undefined) this.partNumber = details.partNumber
    if (details.attempt !== undefined) this.attempt = details.attempt
    if (details.bodySnippet !== undefined) this.bodySnippet = details.bodySnippet
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs
    if (details.cause !== undefined) (this as { cause?: unknown }).cause = details.cause
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      retryable: this.retryable,
      statusCode: this.statusCode,
      partNumber: this.partNumber,
      attempt: this.attempt,
      bodySnippet: this.bodySnippet,
      retryAfterMs: this.retryAfterMs,
    }
  }
}

export function isVikingError(value: unknown): value is VikingError {
  return value instanceof VikingError
}
