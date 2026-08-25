/**
 * Client-side relay HTTP client — lives in ELECTRON MAIN only.
 *
 * The permanent bearer token never reaches the renderer: it is stored
 * encrypted (safeStorage) and attached here, in the main process, on every
 * authenticated request against the Server PC's /v1 REST API.
 */
import { ApiRoutes, type ServerStatusResponse } from '@shared/api'

export type RelayErrorKind =
  | 'unreachable'
  | 'timeout'
  | 'unauthorized'
  | 'rate_limited'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'api'

export class RelayClientError extends Error {
  readonly kind: RelayErrorKind
  readonly status?: number
  readonly code?: string
  readonly retryAfterMs?: number

  constructor(init: {
    kind: RelayErrorKind
    message: string
    status?: number
    code?: string
    retryAfterMs?: number
  }) {
    super(init.message)
    this.name = 'RelayClientError'
    this.kind = init.kind
    this.status = init.status
    this.code = init.code
    this.retryAfterMs = init.retryAfterMs
  }
}

export interface RelayEndpoint {
  host: string
  port: number
}

export interface RelayRequestOptions {
  token?: string | null
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 10_000

/** Validates a Radmin-style IPv4 literal (no DNS names, no 0.0.0.0). */
export function isValidServerHost(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host.trim())
  if (!m) return false
  return m.slice(1).every((octet) => {
    const n = Number(octet)
    return Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === octet.replace(/^0+(?=.)|^$/, (s) => s)
  })
}

export class RelayHttpClient {
  constructor(
    private readonly endpoint: RelayEndpoint,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  baseUrl(): string {
    return `http://${this.endpoint.host}:${this.endpoint.port}`
  }

  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options: RelayRequestOptions = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    const onOuterAbort = (): void => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onOuterAbort, { once: true })

    try {
      const headers: Record<string, string> = {}
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      if (options.token) headers.Authorization = `Bearer ${options.token}`

      let response: Response
      try {
        response = await this.fetchImpl(`${this.baseUrl()}${path}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        })
      } catch {
        if (options.signal?.aborted) {
          throw new RelayClientError({ kind: 'timeout', message: 'request aborted' })
        }
        throw new RelayClientError({
          kind: 'unreachable',
          message: `server ${this.endpoint.host}:${this.endpoint.port} is unreachable`,
        })
      }

      if (response.status === 401) {
        throw new RelayClientError({
          kind: 'unauthorized',
          status: 401,
          code: 'unauthorized',
          message: 'not authorized on this server (pairing may have been revoked)',
        })
      }

      if (!response.ok) {
        const payload = (await safeJson(response)) as {
          error?: string
          message?: string
          retryAfterMs?: number
        } | null
        const code = typeof payload?.error === 'string' ? payload.error : undefined
        const kind: RelayErrorKind =
          response.status === 404
            ? 'not_found'
            : response.status === 409
              ? 'conflict'
              : response.status === 429
                ? 'rate_limited'
                : response.status === 400 || response.status === 422 || response.status === 413
                  ? 'validation'
                  : 'api'
        throw new RelayClientError({
          kind,
          status: response.status,
          code,
          retryAfterMs: typeof payload?.retryAfterMs === 'number' ? payload.retryAfterMs : undefined,
          message: humanizeApiError(kind, code, response.status, payload?.message),
        })
      }

      return (await response.json()) as T
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  health(timeoutMs = 4000): Promise<{ ok: true }> {
    return this.request<{ ok: true }>('GET', ApiRoutes.health, undefined, { timeoutMs })
  }

  /** AUTHENTICATED liveness probe — 401s when the token was revoked. */
  serverStatus(token?: string | null, timeoutMs = 4000): Promise<ServerStatusResponse> {
    return this.request<ServerStatusResponse>('GET', ApiRoutes.serverStatus, undefined, {
      token,
      timeoutMs,
    })
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function humanizeApiError(
  kind: RelayErrorKind,
  code: string | undefined,
  status: number,
  serverMessage?: string,
): string {
  const detail = typeof serverMessage === 'string' && serverMessage.trim() ? `: ${serverMessage.trim()}` : ''
  switch (code ?? kind) {
    case 'job_not_found':
      return 'that job no longer exists on the server'
    case 'job_conflict':
      return 'the server cannot do that right now (state conflict)'
    case 'invalid_code':
      return 'the pairing code was not accepted'
    case 'expired_code':
      return 'the pairing code has expired — generate a new one'
    case 'rate_limited':
      return 'too many attempts — wait a moment and retry'
    case 'validation_error':
      return 'the server rejected this request as invalid'
    case 'internal_error':
      return `server error (${status})${detail || ' — check the server log for details'}`
    default:
      return `server error (${status})${detail}`
  }
}
