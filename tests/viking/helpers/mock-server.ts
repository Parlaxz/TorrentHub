import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Local mock of the VikingFile "fast" multipart API for tests.
 * Mirrors https://vikingfile.com/api behavior with injectable failures.
 */

export interface FailSpec {
  partNumber: number
  times: number
  status?: number
  retryAfter?: string
}

export interface ResetSpec {
  partNumber: number
  times: number
}

export interface StallSpec {
  partNumber: number
  times: number
  ms: number
}

export interface MockVikingOptions {
  partSize?: number
  partDelayMs?: number
  failPart?: FailSpec
  resetPart?: ResetSpec
  stallPart?: StallSpec
  sessionOverride?: () => unknown | undefined
  sessionStatus?: number
  completeFail?: { times: number; status: number }
  completeResponse?: unknown
  checkFileResponse?: unknown
}

export interface MockVikingState {
  sessionRequests: number
  partAttempts: Map<number, number>
  partBodies: Map<number, Buffer>
  etagsIssued: Map<number, string>
  activeParts: number
  maxActiveParts: number
  completeRequests: Array<Record<string, string>>
  checkFileRequests: Array<Record<string, string>>
}

export interface MockViking {
  url: string
  state: MockVikingState
  close(): Promise<void>
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseForm(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(body.toString('utf8'))) out[k] = v
  return out
}

export function createMockViking(options: MockVikingOptions = {}): Promise<MockViking> {
  const partSize = options.partSize ?? 64 * 1024
  const state: MockVikingState = {
    sessionRequests: 0,
    partAttempts: new Map(),
    partBodies: new Map(),
    etagsIssued: new Map(),
    activeParts: 0,
    maxActiveParts: 0,
    completeRequests: [],
    checkFileRequests: [],
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')

      if (req.method === 'POST' && url.pathname === '/api/get-upload-url') {
        state.sessionRequests += 1
        const overridden = options.sessionOverride?.()
        if (overridden !== undefined) {
          const status = options.sessionStatus ?? 200
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(typeof overridden === 'string' ? overridden : JSON.stringify(overridden))
          return
        }
        const form = parseForm(await readBody(req))
        const size = Number(form.size)
        if (!Number.isSafeInteger(size) || size <= 0) {
          res.writeHead(400).end(JSON.stringify({ error: 'missing size' }))
          return
        }
        const numberParts = Math.ceil(size / partSize)
        const port = (server.address() as AddressInfo).port
        const host = `http://127.0.0.1:${port}`
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            uploadId: 'MOCKUPLOADID123',
            key: 'mockkey',
            partSize,
            numberParts,
            urls: Array.from({ length: numberParts }, (_, i) =>
              `${host}/put/${i + 1}?partNumber=${i + 1}&uploadId=MOCKUPLOADID123`,
            ),
          }),
        )
        return
      }

      const putMatch = /^\/put\/(\d+)$/.exec(url.pathname)
      if (req.method === 'PUT' && putMatch) {
        const partNumber = Number(putMatch[1])
        state.partAttempts.set(partNumber, (state.partAttempts.get(partNumber) ?? 0) + 1)
        const attempts = state.partAttempts.get(partNumber) ?? 1
        state.activeParts += 1
        state.maxActiveParts = Math.max(state.maxActiveParts, state.activeParts)

        const finish = (): void => {
          state.activeParts -= 1
        }

        const reset = options.resetPart
        if (reset && reset.partNumber === partNumber && attempts <= reset.times) {
          req.socket.destroy()
          finish()
          return
        }
        const stall = options.stallPart
        if (stall && stall.partNumber === partNumber && attempts <= stall.times) {
          setTimeout(() => {
            res.writeHead(200, { ETag: `"stall-etag-${partNumber}"` })
            res.end()
            finish()
          }, stall.ms)
          return
        }
        const fail = options.failPart
        if (fail && fail.partNumber === partNumber && attempts <= fail.times) {
          const headers: Record<string, string> = {}
          if (fail.retryAfter !== undefined) headers['Retry-After'] = fail.retryAfter
          res.writeHead(fail.status ?? 500, headers)
          res.end(JSON.stringify({ error: 'injected failure' }))
          finish()
          return
        }

        const body = await readBody(req)
        state.partBodies.set(partNumber, body)
        if (options.partDelayMs) await new Promise((r) => setTimeout(r, options.partDelayMs))
        const etag = `"etag-${partNumber}-${attempts}"`
        state.etagsIssued.set(partNumber, etag)
        res.writeHead(200, { ETag: etag })
        res.end()
        finish()
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/complete-upload') {
        const form = parseForm(await readBody(req))
        state.completeRequests.push(form)
        const cf = options.completeFail
        if (cf && state.completeRequests.length <= cf.times) {
          res.writeHead(cf.status).end(JSON.stringify({ error: 'injected complete failure' }))
          return
        }
        const response =
          options.completeResponse ??
          (() => {
            const name = form.name ?? 'example.bin'
            let size = 0
            for (const body of state.partBodies.values()) size += body.length
            return { name, size, hash: 'TPRSfLvcIu', url: `https://vikingfile.com/f/TPRSfLvcIu` }
          })()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/check-file') {
        const form = parseForm(await readBody(req))
        state.checkFileRequests.push(form)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(options.checkFileResponse ?? { exist: true, name: 'example.bin', size: 1 }))
        return
      }

      res.writeHead(404).end('not found')
    })().catch(() => {
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
            server.closeAllConnections()
          }),
      })
    })
  })
}
