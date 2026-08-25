import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * REAL local HTTP mock of the qBittorrent WebUI v2 API for E2E.
 * (tests/qbit/mock.ts is fetch-level; E2E needs a wire-level server.)
 *
 * Scenario-driven: metadata fixture + scripted download progression
 * (each /torrents/info poll advances progress; at completion the mock writes
 * deterministic file content under the torrent save path so downstream
 * packaging/upload stages operate on REAL files).
 */

export interface QbitFileSpec {
  path: string
  length: number
}

export interface QbitScenario {
  /** qBittorrent version string reported by /app/version. Default v5.2.0. */
  appVersion?: string
  /** WebAPI version. Default 2.11.9. */
  webapiVersion?: string
  torrentName?: string
  files?: QbitFileSpec[]
  infoHash?: string
  /** Reject adds with this status N times. */
  failAdd?: { times: number; status: number }
  /** Fail /torrents/info with this status N times. */
  failInfo?: { times: number; status: number }
  /** Fail metadata fetch with this status forever until cleared. */
  failMetadataStatus?: number
  /** Number of /info polls from add until download completes. Default 3. */
  downloadTicks?: number
  /** Enforce Authorization: Bearer <key>. Default 'e2e-qbit-key'. */
  requireApiKey?: string | null
}

export interface RecordedQbitRequest {
  method: string
  path: string
  query: Record<string, string>
  bodyPreview: string
  headers: Record<string, string>
  at: string
}

export interface MockQbit {
  url: string
  port: number
  requests: RecordedQbitRequest[]
  addedTorrents: Array<{ hash: string; savePath: string | null; tags: string[] }>
  deletedHashes: string[]
  scenario: QbitScenario
  setScenario(patch: Partial<QbitScenario>): void
  close(): Promise<void>
}

const DEFAULT_FILES: QbitFileSpec[] = [
  { path: 'Movie/movie.mkv', length: 400_000 },
  { path: 'Movie/sample.mkv', length: 50_000 },
  { path: 'Movie/subs.srt', length: 10_000 }
]

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Extracts named form fields from urlencoded OR multipart bodies (latin1-safe). */
function extractFields(body: Buffer): Record<string, string> {
  const text = body.toString('latin1')
  const out: Record<string, string> = {}
  if (text.includes('Content-Disposition: form-data')) {
    const parts = text.split(/--[\w-]+/)
    for (const part of parts) {
      const nameMatch = /name="([^"]+)"/.exec(part)
      if (!nameMatch) continue
      const valueStart = part.indexOf('\r\n\r\n')
      if (valueStart < 0) continue
      let value = part.slice(valueStart + 4)
      if (value.endsWith('\r\n')) value = value.slice(0, -2)
      out[nameMatch[1]] = value
    }
  } else {
    for (const [k, v] of new URLSearchParams(text)) out[k] = v
  }
  return out
}

function deterministicContent(path: string, length: number): Buffer {
  // Small deterministic payloads keep packaging fast but real.
  const size = Math.min(length, 8192)
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i++) buf[i] = (path.charCodeAt(i % path.length) + i) % 251
  return buf
}

interface TorrentState {
  hash: string
  savePath: string | null
  tags: string[]
  polls: number
  completed: boolean
  stopped: boolean
}

export function createMockQbit(scenario: QbitScenario = {}): Promise<MockQbit> {
const state = {
  scenario,
  requests: [] as RecordedQbitRequest[],
  torrents: new Map<string, TorrentState>(),
  deletedHashes: [] as string[],
  failInfoCount: 0,
  failAddCount: 0
}

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const body = await readBody(req)
      const rec: RecordedQbitRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        bodyPreview: body.subarray(0, 400).toString('utf8'),
        headers: { authorization: String(req.headers.authorization ?? '') },
        at: new Date().toISOString()
      }
      state.requests.push(rec)

      const requiredKey = state.scenario.requireApiKey === undefined ? 'e2e-qbit-key' : state.scenario.requireApiKey
      if (requiredKey) {
        const auth = req.headers.authorization ?? ''
        if (auth !== `Bearer ${requiredKey}`) {
          res.writeHead(403).end('Forbidden')
          return
        }
      }

      const s = state.scenario
      if (req.method === 'GET' && url.pathname === '/api/v2/app/version') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end(s.appVersion ?? 'v5.2.0')
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/v2/app/webapiVersion') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end(s.webapiVersion ?? '2.11.9')
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/v2/torrents/fetchMetadata') {
        if (s.failMetadataStatus !== undefined) {
          res.writeHead(s.failMetadataStatus).end(JSON.stringify({ error: 'injected metadata failure' }))
          return
        }
        const hash = s.infoHash ?? '0123456789abcdef0123456789abcdef01234567'
        const files = s.files ?? DEFAULT_FILES
        const total = files.reduce((acc, f) => acc + f.length, 0)
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            hash,
            infohash_v1: hash,
            infohash_v2: '',
            info: {
              files,
              length: total,
              name: s.torrentName ?? 'Movie 2024',
              piece_length: 16_384,
              pieces_num: Math.ceil(total / 16_384),
              private: false
            },
            trackers: [{ url: 'http://tracker.e2e/announce', tier: 0 }],
            webseeds: []
          })
        )
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/v2/torrents/add') {
        if (s.failAdd && state.failAddCount < s.failAdd.times) {
          state.failAddCount += 1
          res.writeHead(s.failAdd.status).end('Fails.')
          return
        }
        const fields = extractFields(body)
        const hash = s.infoHash ?? '0123456789abcdef0123456789abcdef01234567'
        const tags = (fields.tags ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
        state.torrents.set(hash, {
          hash,
          savePath: fields.savepath ?? null,
          tags,
          polls: 0,
          completed: false,
          stopped: false
        })
        res.writeHead(200, { 'content-type': 'text/plain' }).end('Ok.')
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/v2/torrents/info') {
        if (s.failInfo && state.failInfoCount < s.failInfo.times) {
          state.failInfoCount += 1
          res.writeHead(s.failInfo.status).end(JSON.stringify({ error: 'injected info failure' }))
          return
        }
        const wanted = url.searchParams.get('hashes')
        const hashes = wanted ? wanted.split('|') : [...state.torrents.keys()]
        const ticks = s.downloadTicks ?? 3
        const out = []
        for (const hash of hashes) {
          const t = state.torrents.get(hash)
          if (!t) continue
          t.polls += 1
          const done = t.polls > ticks
          if (done && !t.completed) {
            t.completed = true
            writeCompletedFiles(t, s)
          }
          const files = s.files ?? DEFAULT_FILES
          const total = files.reduce((acc, f) => acc + f.length, 0)
          const progress = t.completed ? 1 : Math.min(0.99, (t.polls - 1) / ticks)
          out.push({
            hash: t.hash,
            name: s.torrentName ?? 'Movie 2024',
            state: t.completed ? 'uploading' : t.stopped ? 'stoppedDL' : 'downloading',
            progress,
            size: total,
            total_size: total,
            downloaded: Math.round(total * progress),
            downloaded_session: Math.round(total * progress),
            completed: Math.round(total * progress),
            amount_left: total - Math.round(total * progress),
            dlspeed: t.completed ? 0 : 262_144,
            upspeed: 1024,
            eta: t.completed ? 8640000 : 120,
            num_seeds: 3,
            num_complete: 12,
            num_leechs: 2,
            num_incomplete: 40,
            category: '',
            tags: t.tags,
            save_path: t.savePath ?? '',
            content_path: t.savePath ? join(t.savePath, s.torrentName ?? 'Movie 2024') : '',
            completion_on: 0,
            added_on: Math.floor(Date.now() / 1000),
            availability: 1.5,
            magnet_uri: `magnet:?xt=urn:btih:${t.hash}&dn=Movie`,
            auto_tmm: false
          })
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/v2/torrents/files') {
        const hash = url.searchParams.get('hash') ?? ''
        const t = state.torrents.get(hash)
        const files = s.files ?? DEFAULT_FILES
        const progress = t?.completed ? 1 : 0
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify(
            files.map((f, index) => ({
              index,
              name: f.path,
              size: f.length,
              progress,
              priority: 1,
              availability: 0,
              piece_range: [index * 10, index * 10 + 9],
              ...(index === 0 ? { is_seed: false } : {})
            }))
          )
        )
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/v2/torrents/filePrio') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('Ok.')
        return
      }
      if (
        req.method === 'POST' &&
        (url.pathname === '/api/v2/torrents/start' || url.pathname === '/api/v2/torrents/stop' ||
         url.pathname === '/api/v2/torrents/resume')
      ) {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('Ok.')
        return
      }
      // Ownership bookkeeping endpoints used by the commit flow.
      if (
        req.method === 'POST' &&
        (url.pathname === '/api/v2/torrents/createCategory' ||
         url.pathname === '/api/v2/torrents/setCategory' ||
         url.pathname === '/api/v2/torrents/createTags' ||
         url.pathname === '/api/v2/torrents/addTags' ||
         url.pathname === '/api/v2/torrents/removeTags')
      ) {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('Ok.')
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/v2/torrents/delete') {
        // qBittorrent WebAPI takes POST form fields; fall back to query.
        const fields = extractFields(body)
        const raw = fields.hashes ?? url.searchParams.get('hashes') ?? ''
        const hashes = raw.split('|').filter(Boolean)
        for (const h of hashes) {
          state.torrents.delete(h)
          state.deletedHashes.push(h)
        }
        res.writeHead(200, { 'content-type': 'text/plain' }).end('Ok.')
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

  const mock: MockQbit = {
    url: '',
    port: 0,
    requests: state.requests,
    addedTorrents: [],
    deletedHashes: state.deletedHashes,
    scenario,
    setScenario(patch: Partial<QbitScenario>) {
      Object.assign(state.scenario, patch)
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      mock.port = addr.port
      mock.url = `http://127.0.0.1:${addr.port}`
      resolve(mock)
    })
  })
}

/** Deterministic content pattern shared by the mock writer and specs
 * (byte-exact upload assertions). Chunk-local so any 64KB window is stable. */
export function mockFileContent(path: string, length: number): Buffer {
  const CHUNK = 65_536
  const chunk = Buffer.alloc(CHUNK)
  for (let i = 0; i < CHUNK; i++) chunk[i] = (path.charCodeAt(i % path.length) + i) % 251
  const out = Buffer.alloc(length)
  let written = 0
  while (written < length) {
    const size = Math.min(CHUNK, length - written)
    chunk.copy(out, written, 0, size)
    written += size
  }
  return out
}

/** Writes deterministic content of the FULL declared length (packaging
 * verifies source sizes against metadata). Chunked to avoid huge buffers.
 * Files larger than WRITE_CAP_BYTES are deliberately NOT written: scenarios
 * declaring huge sizes (storage-warning bands) only need preflight math, and
 * materializing them would threaten real disk space. Packaging then fails
 * honestly with SelectedSourceMissing if such a job is started. */
const WRITE_CAP_BYTES = 16 * 1024 * 1024

function writeCompletedFiles(t: TorrentState, s: QbitScenario): void {
  if (!t.savePath) return
  for (const f of s.files ?? DEFAULT_FILES) {
    if (f.length > WRITE_CAP_BYTES) continue
    const target = join(t.savePath, ...f.path.split('/'))
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, mockFileContent(f.path, f.length))
    } catch {
      // Surface later via packaging failure — do not mask with a fake success.
    }
  }
}
