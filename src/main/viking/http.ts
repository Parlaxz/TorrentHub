import http from 'node:http'
import https from 'node:https'
import type { Readable } from 'node:stream'

/**
 * Minimal HTTP layer over node:http/https (NOT fetch).
 *
 * Rationale: native fetch gives no reliable per-chunk upload progress for
 * streamed bodies, and undici's duplex streaming is awkward to bound.
 * node request streams let us count exactly the bytes handed to the socket
 * and destroy the request on timeout/abort without buffering the body.
 */

export interface HttpResponse {
  status: number
  headers: http.IncomingHttpHeaders
  /** Full response body (API responses are small; capped). */
  body: Buffer
  /** Bytes this request wrote to the socket layer. */
  bytesWritten: number
}

export interface HttpRequestOptions {
  method: 'GET' | 'POST' | 'PUT'
  url: string
  headers?: Record<string, string>
  /** Small buffered body (form posts). */
  body?: Buffer | string
  /** Streamed body (part uploads); requires contentLength. */
  bodyStream?: Readable
  contentLength?: number
  /**
   * Stall timeout in ms: if no bytes are written and no response bytes
   * arrive for this long, the request is destroyed. Default 60000. 0 disables.
   */
  timeoutMs?: number
  signal?: AbortSignal
  /** Called with chunk sizes as bytes are handed to the socket. */
  onBytesWritten?: (chunkBytes: number) => void
  /** Max response body size. Default 1 MiB. */
  maxResponseBytes?: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024

const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 16 })
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 16 })

function isNetworkErrorCode(code: string): boolean {
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'UND_ERR_SOCKET'
  )
}

/** True when an error thrown by httpRequest() may be retried as-is. */
export function isTransientTransportError(error: unknown): boolean {
  const err = error as { code?: string; kind?: string }
  if (err && typeof err === 'object') {
    if (err.kind === 'timeout' || err.kind === 'aborted') return err.kind === 'timeout'
    if (typeof err.code === 'string' && isNetworkErrorCode(err.code)) return true
  }
  return false
}

export class HttpStallTimeoutError extends Error {
  readonly url: string
  constructor(url: string) {
    super(`Request stalled for more than the configured timeout: ${sanitizeUrl(url)}`)
    this.name = 'HttpStallTimeoutError'
    this.url = url
  }
}

export class HttpAbortedError extends Error {
  constructor() {
    super('Request aborted')
    this.name = 'HttpAbortedError'
  }
}

/** Strips query strings (signed URLs contain uploadId/key) before logging. */
export function sanitizeUrl(url: string): string {
  const idx = url.indexOf('?')
  return idx === -1 ? url : `${url.slice(0, idx)}?…`
}

export function httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(options.url)
    } catch {
      reject(new Error(`Invalid URL: ${sanitizeUrl(options.url)}`))
      return
    }
    const isHttps = parsed.protocol === 'https:'
    if (!isHttps && parsed.protocol !== 'http:') {
      reject(new Error(`Unsupported protocol: ${parsed.protocol}`))
      return
    }

    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const req = (isHttps ? https : http).request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method,
        agent: isHttps ? keepAliveHttps : keepAliveHttp,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        let received = 0
        res.on('data', (chunk: Buffer) => {
          bumpActivity()
          received += chunk.length
          if (received > maxResponseBytes) {
            res.destroy()
            cleanup()
            reject(new Error(`Response body exceeded ${maxResponseBytes} bytes`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          cleanup()
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            bytesWritten,
          })
        })
        res.on('error', (err) => {
          cleanup()
          reject(err)
        })
      },
    )

    let bytesWritten = 0
    let stalled = false
    let timer: NodeJS.Timeout | null = null
    let settled = false

    const onAbort = () => {
      stalled = false
      req.destroy(new HttpAbortedError())
    }

    function cleanup(): void {
      settled = true
      if (timer) clearTimeout(timer)
      timer = null
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
    }

    function stallOut(): void {
      stalled = true
      req.destroy(new HttpStallTimeoutError(options.url))
    }

    function bumpActivity(): void {
      if (!settled && timeoutMs > 0) {
        if (timer) clearTimeout(timer)
        timer = setTimeout(stallOut, timeoutMs)
      }
    }

    req.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      cleanup()
      if (stalled || err instanceof HttpStallTimeoutError) {
        reject(new HttpStallTimeoutError(options.url))
      } else if (err instanceof HttpAbortedError || err.code === 'ABORT_ERR') {
        reject(new HttpAbortedError())
      } else {
        reject(err)
      }
    })

    if (options.signal && options.signal.aborted) {
      // Fail fast before doing any I/O.
      req.destroy()
      cleanup()
      setImmediate(() => reject(new HttpAbortedError()))
      return
    }

    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    req.on('socket', (socket) => {
      socket.on('data', () => bumpActivity())
    })

    bumpActivity()

    const finishWithBuffer = (): void => {
      const headers = { ...options.headers }
      if (options.contentLength !== undefined && headers['Content-Length'] === undefined) {
        headers['Content-Length'] = String(options.contentLength)
      }
      for (const [key, value] of Object.entries(headers)) req.setHeader(key, value)
      if (options.body !== undefined) {
        const buf = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body)
        req.end(buf)
      } else if (options.bodyStream) {
        options.bodyStream.on('data', (chunk: Buffer) => {
          bytesWritten += chunk.length
          options.onBytesWritten?.(chunk.length)
          bumpActivity()
        })
        options.bodyStream.on('error', (err) => {
          req.destroy(err)
        })
        // Free the source fd if the request dies before the stream finishes.
        req.on('close', () => {
          if (!req.writableFinished) options.bodyStream?.destroy()
        })
        // pipe preserves backpressure; end the request when the stream ends.
        options.bodyStream.pipe(req)
      } else {
        req.end()
      }
    }

    finishWithBuffer()
  })
}
