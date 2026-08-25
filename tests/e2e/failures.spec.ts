import { test, expect } from '@playwright/test'
import http from 'node:http'
import { existsSync, mkdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppHandle } from './harness/app'
import {
  E2E_MAGNET,
  launchServer,
  pairClient,
  startRelay,
  type PairedClient,
  type ServerCluster
} from './harness/cluster'
import { getFreePort } from './harness/paths'

/**
 * FAIL lane — qbit/viking/storage/ratelimit error paths.
 * Per docs/E2E-EXHAUSTIVE-TEST-PLAN.md §FAIL (FAIL-001..042).
 *
 * NOTE: earlier harness-gap workarounds (8192-byte content cap, mock writing
 * files under an extra torrent-name directory) are OBSOLETE — the wire-level
 * qbit mock now writes full-length files at `<savePath>/<file.path>` and
 * exports mockFileContent for byte-exact assertions.
 */

const GIB = 1024 ** 3

/** Multi-file scenario with sizes the mock can reproduce byte-exactly. */
const SMALL_FILES = [
  { path: 'Movie/movie.mkv', length: 4000 },
  { path: 'Movie/subs.srt', length: 1000 }
]

/** Complete-upload response pointing at a non-/f/ URL so finalize never
 *  contacts the real vikingfile.com (resolveDirectLink short-circuits). */
const LOCAL_COMPLETE = {
  name: 'mock.bin',
  size: 123,
  hash: 'MOCKHASH123',
  url: 'http://127.0.0.1:9/mock/mock.bin'
}

/* ------------------------------------------------------------------ */
/* fixtures + helpers                                                  */

let server: ServerCluster | null = null
const clients: PairedClient[] = []
const localServers: Array<{ close(): Promise<void> }> = []

test.afterEach(async () => {
  for (const c of clients) await c.close().catch(() => undefined)
  clients.length = 0
  if (server) {
    await server.close()
    server = null
  }
  for (const s of localServers) await s.close().catch(() => undefined)
  localServers.length = 0
})

function relayBase(s: ServerCluster): string {
  return `http://${s.relayAddress}:${s.relayPort}`
}

/** Spec-local origin server for the "direct download" intake path. */
function startPayloadServer(bytes: Buffer): Promise<{ port: number; url: string; close(): Promise<void> }> {
  const s = http.createServer((req, res) => {
    if (req.headers.range) {
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': `bytes 0-0/${bytes.length}`,
        'content-length': 1,
        'content-disposition': 'attachment; filename="payload.bin"'
      })
      res.end(bytes.subarray(0, 1))
      return
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': bytes.length,
      'content-disposition': 'attachment; filename="payload.bin"'
    })
    res.end(bytes)
  })
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      resolve({
        port,
        url: `http://127.0.0.1:${port}/payload.bin`,
        close: () => new Promise<void>((res) => s.close(() => res()))
      })
    })
  })
}

async function rawPair(
  s: ServerCluster,
  name?: string
): Promise<{ token: string; clientId: string; status: number; body: Record<string, unknown> }> {
  const gen = (await s.app.serverBridge<Record<string, unknown>>('generatePairingCode()')) as Record<
    string,
    unknown
  >
  const code = gen['code'] as string
  const res = await fetch(`${relayBase(s)}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, ...(name ? { name } : {}) })
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return {
    token: String(body['token'] ?? ''),
    clientId: String(body['clientId'] ?? ''),
    status: res.status,
    body
  }
}

function readJobs(app: AppHandle): Array<Record<string, unknown>> {
  const raw = app.readPersisted(join('data', 'job-history.json'))
  if (!raw) return []
  try {
    return ((JSON.parse(raw) as { jobs?: Array<Record<string, unknown>> }).jobs ?? []) as Array<
      Record<string, unknown>
    >
  } catch {
    return []
  }
}

async function submitOnHome(client: AppHandle, text: string): Promise<void> {
  const input = client.page.getByLabel('Torrent magnet link or URL')
  await input.waitFor({ state: 'visible', timeout: 15_000 })
  await input.fill(text)
  await client.page.getByRole('button', { name: 'Continue' }).click()
}

async function waitSelection(app: AppHandle, torrentName: string, timeoutMs = 25_000): Promise<void> {
  await app.waitFor(
    `selection screen for "${torrentName}"`,
    async () => app.page.getByText(torrentName, { exact: false }).first().isVisible().catch(() => false),
    { timeoutMs }
  )
}

async function waitErrorTitle(app: AppHandle, title: string, timeoutMs = 25_000): Promise<void> {
  await app.waitFor(
    `error screen titled "${title}"`,
    async () =>
      app.page
        .getByRole('heading', { name: title, exact: true })
        .first()
        .isVisible()
        .catch(() => false),
    { timeoutMs }
  )
}

async function confirmSelectionAndStart(app: AppHandle): Promise<void> {
  // SelectionScreen Continue -> server preflight -> Start becomes available.
  await app.page.getByRole('button', { name: 'Continue' }).click()
  await app.page.getByRole('button', { name: 'Start', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await app.page.getByRole('button', { name: 'Start', exact: true }).click()
}

function freeBytesOf(dir: string): number | null {
  try {
    const fsMod = require('node:fs') as typeof import('node:fs')
    const stats = (fsMod as unknown as { statfsSync?: (p: string) => { bavail: number; bsize: number } })
      .statfsSync
    if (!stats) return null
    const s = stats(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* FAIL-001 / FAIL-002                                                 */

test('FAIL-001: metadata fetch 500 → truthful error, Back works, clearing scenario allows retry success', async () => {
  server = await launchServer({
    testId: 'FAIL-001',
    qbitScenario: { failMetadataStatus: 500 }
  })
  const client = await pairClient({ testId: 'FAIL-001', server })
  clients.push(client)

  await submitOnHome(client.app, E2E_MAGNET)

  // Draft fails with kind:"metadata"; errors.ts classifies the wrapped
  // QbitApiError message ("metadata fetch failed: …") as metadata_unavailable.
  await waitErrorTitle(client.app, 'Metadata unavailable')
  await expect(client.app.page.getByText(/metadata fetch failed/i).first()).toBeVisible()

  // User can go back home.
  await client.app.page.getByRole('button', { name: 'Back' }).click()
  await expect(client.app.page.getByLabel('Torrent magnet link or URL')).toBeVisible({ timeout: 10_000 })

  // Clearing the injected failure allows a successful retry.
  server.qbit.setScenario({ failMetadataStatus: undefined })
  await submitOnHome(client.app, E2E_MAGNET)
  await waitSelection(client.app, 'Movie 2024')
})

test('FAIL-002: viking session returns malformed JSON (HTTP 200) → handled without crash, upload error shown', async () => {
  const payload = await startPayloadServer(Buffer.alloc(64 * 1024, 7))
  localServers.push(payload)

  server = await launchServer({
    testId: 'FAIL-002',
    vikingOptions: {
      sessionOverride: () => 'not-json',
      sessionStatus: 200,
      completeResponse: LOCAL_COMPLETE
    }
  })
  const client = await pairClient({ testId: 'FAIL-002', server })
  clients.push(client)
  const baselineErrors = client.app.pageErrorCount()

  // Direct-download intake (non-.torrent URL) reaches upload with a REAL file.
  await submitOnHome(client.app, payload.url)
  await waitSelection(client.app, 'payload.bin')
  await confirmSelectionAndStart(client.app)

  // VikingClient.parseJsonBody throws kind:"malformed_response" (non-retryable)
  // → job failed with error kind "upload" → ErrorScreen "Viking upload failed".
  await waitErrorTitle(client.app, 'Viking upload failed')
  await expect(client.app.page.getByRole('button', { name: 'Retry Upload' })).toBeVisible()

  // Non-retryable: exactly one session attempt, no retry loop.
  expect(server.viking.state.sessionRequests).toBe(1)
  // Malformed response was handled gracefully — no renderer crashes.
  expect(client.app.pageErrorCount()).toBe(baselineErrors)
})

/* ------------------------------------------------------------------ */
/* FAIL-010..012 storage preflight                                     */

test('FAIL-010: storage preflight blocks start when required peak exceeds free space', async () => {
  server = await launchServer({ testId: 'FAIL-010' })
  const client = await pairClient({ testId: 'FAIL-010', server })
  clients.push(client)

  // Measure the actual volume the server will download onto and size the
  // torrent so required peak (= size + max(2 GiB, 5%) reserve, spacePolicy.ts)
  // provably exceeds free space. Baseline per plan: ~200 GB.
  const free = freeBytesOf(server.dataDir)
  test.skip(free === null, 'statfs unavailable in this environment — cannot size deterministically')
  const totalBytes = Math.max(200_000_000_000, Math.ceil(free! * 1.5))
  server.qbit.setScenario({
    torrentName: 'BigBlob',
    files: [{ path: 'Big/big.bin', length: totalBytes }]
  })

  await submitOnHome(client.app, E2E_MAGNET)
  await waitSelection(client.app, 'BigBlob')
  await client.app.page.getByRole('button', { name: 'Continue' }).click()

  // Blocked verdict UI: badge, truthful deficit messaging, disabled Start.
  await expect(client.app.page.getByText('⚠ Blocked').first()).toBeVisible({ timeout: 15_000 })
  const alert = client.app.page.getByText(/NOT ENOUGH SERVER STORAGE — need approximately ([\d.]+) GB more/)
  await expect(alert.first()).toBeVisible()
  const match = /need approximately ([\d.]+) GB more/.exec((await alert.first().textContent()) ?? '')
  expect(match).toBeTruthy()
  expect(Number(match![1])).toBeGreaterThan(0) // free < required is actually reflected

  const blockedStart = client.app.page.getByRole('button', { name: 'Storage blocked' })
  await expect(blockedStart).toBeVisible()
  await expect(blockedStart).toBeDisabled()

  // Job stays awaiting_selection so the user can retry after freeing space.
  // NOTE: job history persists in the SERVER instance's userData.
  await client.app.waitFor(
    'job still awaiting_selection after blocked preflight',
    async () => {
      const job = readJobs(server!.app).find((j) => j['source'] && (j['state'] === 'awaiting_selection'))
      return Boolean(job)
    },
    { timeoutMs: 10_000 }
  )
})

test('FAIL-011: warning band — mid-size torrent starts (not blocked) and live headroom reports warning=low', async () => {
  server = await launchServer({
    testId: 'FAIL-011',
    vikingOptions: { partSize: GIB } // keep mock session tiny for the huge declared size
  })
  const client = await pairClient({ testId: 'FAIL-011', server })
  clients.push(client)

  const free = freeBytesOf(server.dataDir)
  // spacePolicy math (src/main/storage/spacePolicy.ts):
  //   reserve            = max(2 GiB, ceil(5% of selected))
  //   requiredPeak       = selected + zip(0, single file) + reserve
  //   warningThreshold   = max(1 GiB, ceil(10% of requiredFuture))
  // Choose requiredPeak ≈ 96% of measured free so projected headroom (~4% of
  // free) sits strictly inside [0, warningThreshold) → status "warning".
  test.skip(
    free === null || free < 30 * GIB,
    `machine free space (${free === null ? 'unknown' : `${Math.round(free / GIB)} GiB`}) cannot fit the warning-band scenario deterministically`
  )
  const requiredPeak = Math.floor(free! * 0.96)
  let selected = Math.floor(requiredPeak / 1.05) // assumes 5% reserve branch
  if (selected + 2 * GIB > requiredPeak) selected = requiredPeak - 2 * GIB // floor-reserve branch

  server.qbit.setScenario({
    torrentName: 'BigBlob',
    files: [{ path: 'Big/blob.bin', length: selected }],
    downloadTicks: 25 // ~25s of low-progress polling → throttled saves land in the warning band
  })

  await submitOnHome(client.app, E2E_MAGNET)
  await waitSelection(client.app, 'BigBlob')
  await client.app.page.getByRole('button', { name: 'Continue' }).click()
  // Not blocked: Enough-storage verdict and enabled Start.
  await expect(client.app.page.getByText('✓ Enough storage').first()).toBeVisible({ timeout: 15_000 })
  await client.app.page.getByRole('button', { name: 'Start', exact: true }).click()

  // The live storage view is recomputed each poll tick; with downloadTicks=1
  // the first poll (0% downloaded) must classify warning:"low". The LAST
  // persisted storage snapshot remains on the record after completion, so the
  // persisted record is the authoritative, race-free observation.
  await client.app.waitFor(
    'persisted storage view reports warning=low',
    async () => {
      const jobs = readJobs(server!.app)
      const job = jobs.find((j) => j['metadata'] !== null)
      const storage = job?.['storage'] as { warning?: string } | null | undefined
      return storage?.warning === 'low'
    },
    { timeoutMs: 15_000, pollMs: 100 }
  )

  // Job was started (warning ≠ block). Let it reach any terminal state; the
  // huge declared size makes the tail stages irrelevant to this assertion.
  await client.app.waitFor(
    'job reached terminal state after warning observation',
    async () => {
      const jobs = readJobs(server!.app)
      const job = jobs.find((j) => j['metadata'] !== null)
      return Boolean(job && ['complete', 'failed', 'cancelled'].includes(String(job['state'])))
    },
    { timeoutMs: 90_000 }
  ).catch((err) => {
    // Diagnostic dump: what does the persisted record actually look like?
    const jobs = readJobs(server!.app)
    console.log('FAIL-011 TERMINAL WAIT DUMP:', JSON.stringify(jobs.map((j) => ({ state: j['state'], stages: j['stages'], meta: j['metadata'] !== null }))).slice(0, 500))
    throw err
  })
})

test('FAIL-012: control — small torrent passes preflight and Start is allowed', async () => {
  server = await launchServer({
    testId: 'FAIL-012',
    qbitScenario: { files: SMALL_FILES },
    vikingOptions: { completeResponse: LOCAL_COMPLETE }
  })
  const client = await pairClient({ testId: 'FAIL-012', server })
  clients.push(client)

  await submitOnHome(client.app, E2E_MAGNET)
  await waitSelection(client.app, 'Movie 2024')
  await client.app.page.getByRole('button', { name: 'Continue' }).click()

  await expect(client.app.page.getByText('✓ Enough storage').first()).toBeVisible({ timeout: 15_000 })
  const start = client.app.page.getByRole('button', { name: 'Start', exact: true })
  await expect(start).toBeEnabled()
  await start.click()

  // Pipeline actually starts on the server (and with the fast mock may even
  // finish between polls — history is authoritative).
  await client.app.waitFor(
    'job started after allowed Start',
    async () => {
      const job = (await server!.app.serverBridge<Record<string, unknown> | null>('getActiveJob()')) as Record<
        string,
        unknown
      > | null
      if (job) return job['state'] !== 'awaiting_selection'
      const records = readJobs(server!.app)
      return records.some((r) =>
        ['downloading', 'packaging', 'uploading', 'finalizing', 'complete'].includes(String(r['state']))
      )
    },
    { timeoutMs: 15_000 }
  )
})

/* ------------------------------------------------------------------ */
/* FAIL-020..023 packaging/upload failures                             */

test('FAIL-020: packaging failure → Retry Packaging fails again while obstructed → succeeds after fix', async () => {
  server = await launchServer({
    testId: 'FAIL-020',
    qbitScenario: { files: SMALL_FILES },
    vikingOptions: { completeResponse: LOCAL_COMPLETE }
  })
  const client = await pairClient({ testId: 'FAIL-020', server })
  clients.push(client)

  await submitOnHome(client.app, E2E_MAGNET)
  await waitSelection(client.app, 'Movie 2024')
  await client.app.page.getByRole('button', { name: 'Continue' }).click()
  const startBtn = client.app.page.getByRole('button', { name: 'Start', exact: true })
  await startBtn.waitFor({ state: 'visible', timeout: 15_000 })
  // Route the client into the active phase IMMEDIATELY: commit auto-starts
  // the pipeline, and a pre-Start failure would otherwise be invisible on the
  // Selection screen.
  await startBtn.click()

  // Deterministic first-failure injection while the job is downloading:
  // the packager streams into `<packageDir>/<name>.partial.zip`; a DIRECTORY
  // at that path makes createWriteStream fail (EISDIR/EPERM) every attempt
  // until removed.
  let jobDirRecord: Record<string, unknown> | null = null
  await client.app.waitFor(
    'job actively downloading',
    async () => {
      const job = readJobs(server!.app).find((j) => j['state'] === 'downloading')
      jobDirRecord = job ?? null
      return Boolean(job && job['downloadDir'])
    },
    { timeoutMs: 15_000 }
  )
  const downloadDir = String(jobDirRecord!['downloadDir'])
  const packageDir = join(downloadDir, '..', 'package')
  const partialDir = join(packageDir, 'Movie 2024.partial.zip')
  mkdirSync(partialDir, { recursive: true })

  // Download finishes → packaging hits the obstruction → honest failure.
  await waitErrorTitle(client.app, 'Packaging failed', 45_000)
  expect(server.viking.state.sessionRequests).toBe(0) // never reached upload

  // Retry #1: prerequisites re-checked and pass, packaging fails again.
  await client.app.page.getByRole('button', { name: 'Retry Packaging' }).first().click()
  await waitErrorTitle(client.app, 'Packaging failed', 30_000)
  expect(server.viking.state.sessionRequests).toBe(0) // still never reached upload

  // Remove the obstruction, retry #2 → packaging + upload succeed.
  // Wait until the directory is REALLY gone: on Windows, removing a path
  // another handle just touched can race the very next createWriteStream.
  rmSync(partialDir, { recursive: true, force: true })
  await client.app.waitFor(
    'obstruction fully removed',
    async () => !existsSync(partialDir),
    { timeoutMs: 5000, pollMs: 50 }
  )
  await client.app.page.getByRole('button', { name: 'Retry Packaging' }).first().click()
  await expect(client.app.page.getByRole('heading', { name: 'Complete', exact: true })).toBeVisible({
    timeout: 45_000
  })
  await expect(client.app.page.getByLabel('Viking URL')).toHaveValue(LOCAL_COMPLETE.url)
})

test('FAIL-021: upload permanent failure (403 forever) → terminal failed job; Retry Upload fails again', async () => {
  const payload = await startPayloadServer(Buffer.alloc(64 * 1024, 3))
  localServers.push(payload)

  server = await launchServer({
    testId: 'FAIL-021',
    vikingOptions: {
      sessionOverride: () => ({ error: 'forbidden' }),
      sessionStatus: 403,
      completeResponse: LOCAL_COMPLETE
    }
  })
  const client = await pairClient({ testId: 'FAIL-021', server })
  clients.push(client)

  await submitOnHome(client.app, payload.url)
  await waitSelection(client.app, 'payload.bin')
  await confirmSelectionAndStart(client.app)

  // HTTP 403 is non-retryable (backoff.ts TRANSIENT_STATUS = 408/429/5xx) →
  // immediate terminal failure with error kind "upload".
  await waitErrorTitle(client.app, 'Viking upload failed')
  expect(server.viking.state.sessionRequests).toBe(1)

  // Retry Upload re-checks and fails again while the mock keeps returning 403.
  await client.app.page.getByRole('button', { name: 'Retry Upload' }).first().click()
  await waitErrorTitle(client.app, 'Viking upload failed', 20_000)
  expect(server.viking.state.sessionRequests).toBeGreaterThanOrEqual(2)

  // Wire truth: job history persists in the SERVER instance's userData.
  const failed = readJobs(server!.app).find((j) => j['state'] === 'failed')
  expect(failed).toBeTruthy()
  expect((failed!['error'] as Record<string, unknown>)?.['kind']).toBe('upload')
})

test('FAIL-022: upload transient part failure (500 once) → pipeline retries internally and completes', async () => {
  const payload = await startPayloadServer(Buffer.alloc(64 * 1024, 5)) // exactly one part
  localServers.push(payload)

  server = await launchServer({
    testId: 'FAIL-022',
    vikingOptions: {
      failPart: { partNumber: 1, times: 1, status: 500 },
      completeResponse: LOCAL_COMPLETE
    }
  })
  const client = await pairClient({ testId: 'FAIL-022', server })
  clients.push(client)

  await submitOnHome(client.app, payload.url)
  await waitSelection(client.app, 'payload.bin')
  await confirmSelectionAndStart(client.app)

  // Internal bounded retry (backoff base 500ms full jitter, max 4 attempts):
  // completes WITHOUT any manual retry click.
  await expect(client.app.page.getByRole('heading', { name: 'Complete', exact: true })).toBeVisible({
    timeout: 45_000
  })
  await expect(client.app.page.getByLabel('Viking URL')).toHaveValue(LOCAL_COMPLETE.url)
  expect(server.viking.state.partAttempts.get(1)).toBeGreaterThanOrEqual(2)
})

test('FAIL-023: upload part failure with Retry-After: 1 honored — completes quickly (soft timing)', async () => {
  const payload = await startPayloadServer(Buffer.alloc(64 * 1024, 9))
  localServers.push(payload)

  server = await launchServer({
    testId: 'FAIL-023',
    vikingOptions: {
      failPart: { partNumber: 1, times: 1, status: 429, retryAfter: '1' },
      completeResponse: LOCAL_COMPLETE
    }
  })
  const client = await pairClient({ testId: 'FAIL-023', server })
  clients.push(client)

  await submitOnHome(client.app, payload.url)
  await waitSelection(client.app, 'payload.bin')

  const t0 = Date.now()
  await confirmSelectionAndStart(client.app)

  // Soft timing assertion per plan: Retry-After (1000ms) is honored instead of
  // the default backoff ceiling; the whole job finishes well within 15s.
  await expect(client.app.page.getByRole('heading', { name: 'Complete', exact: true })).toBeVisible({
    timeout: 20_000
  })
  const elapsed = Date.now() - t0
  expect(elapsed).toBeLessThan(15_000)
  expect(server.viking.state.partAttempts.get(1)).toBeGreaterThanOrEqual(2)
})

/* ------------------------------------------------------------------ */
/* FAIL-030 / FAIL-040 / FAIL-041 / FAIL-042                           */

test('FAIL-030: ErrorScreen taxonomy — cancelled job renders Cancelled title/detail/buttons', async () => {
  server = await launchServer({
    testId: 'FAIL-030',
    qbitScenario: { files: SMALL_FILES }
  })
  const client = await pairClient({ testId: 'FAIL-030', server })
  clients.push(client)

  await submitOnHome(client.app, E2E_MAGNET)
  await waitSelection(client.app, 'Movie 2024')
  await confirmSelectionAndStart(client.app)

  // Cancel from OUTSIDE the client UI (raw relay API with a freshly paired
  // token) so the client's 1s job poll observes the terminal "cancelled"
  // state and routes to the ErrorScreen taxonomy.
  // Cancel through the OWNER client's own path. Since DEF-007 was fixed,
  // job mutations are tenant-scoped: a foreign credential would be refused
  // with 404 (see PERM-002), so the taxonomy is exercised via the owner.
  const active = (await server!.app.serverBridge<Record<string, unknown> | null>('getActiveJob()')) as Record<
    string,
    unknown
  > | null
  expect(active, 'active job visible server-side').toBeTruthy()
  // cancelJob resolves void; the terminal-state wait below is the assertion.
  await client.app.clientBridge<void>(`cancelJob('${String(active!['id'])}')`)

  // errors.ts mapping for "cancelled": title "Cancelled", detail
  // "This job was cancelled.", no retry affordances, Back button present.
  await waitErrorTitle(client.app, 'Cancelled')
  await expect(client.app.page.getByText('This job was cancelled.')).toBeVisible()
  await expect(client.app.page.getByRole('button', { name: 'Retry Packaging' })).toHaveCount(0)
  await expect(client.app.page.getByRole('button', { name: 'Retry Upload' })).toHaveCount(0)
  await client.app.page.getByRole('button', { name: 'Back' }).click()
  await expect(client.app.page.getByLabel('Torrent magnet link or URL')).toBeVisible({ timeout: 10_000 })

  // Taxonomy dispositions (documented, not assertable end-to-end today):
  //  - bad_torrent: unreachable — every intake-side qbit failure arrives as
  //    kind:"metadata" and classifies to metadata_unavailable (see FAIL-001);
  //    the mock cannot produce InvalidTorrentSourceError.
  //  - interrupted: requires a mid-job process kill; covered by PERSIST-020.
})

test('FAIL-040: pairing rate limit — 11th wrong-code attempt from one IP gets 429 + Retry-After; valid code also 429s', async () => {
  test.setTimeout(120_000)
  server = await launchServer({ testId: 'FAIL-040' })

  const base = relayBase(server)
  const statuses: number[] = []
  let lastBody: Record<string, unknown> = {}
  let lastHeaders: Headers | null = null

  // ratelimit.ts/pairing.ts: per-IP limit = 10 attempts / 10 min window.
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${base}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'AAAA2222' }) // well-formed but wrong
    })
    statuses.push(res.status)
    lastHeaders = res.headers
    lastBody = (await res.json().catch(() => ({}))) as Record<string, unknown>
  }

  // Attempts 1..10: normal invalid_code (400); 11+: rate_limited (429).
  expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400))
  expect(statuses.slice(10)).toEqual(Array(2).fill(429))
  expect(lastHeaders?.get('retry-after')).toBeTruthy()
  expect(Number(lastBody['retryAfterMs'])).toBeGreaterThan(0)
  expect(lastBody['error']).toBe('rate_limited')

  // Per-IP scope: a VALID code from the same (now limited) IP also 429s.
  const valid = await rawPair(server)
  expect(valid.status).toBe(429)
  expect(valid.body['error']).toBe('rate_limited')
  // Isolation restores the limiter: each test gets a fresh relay process.
})

test('FAIL-041: qBittorrent down at server start → health qbit=error, dashboard shows degraded row while relay online', async () => {
  const closedPort = await getFreePort() // bound then released → nothing listens
  server = await launchServer({
    testId: 'FAIL-041',
    skipAutoStart: true,
    settings: { qbittorrentBaseUrl: `http://127.0.0.1:${closedPort}` }
  })

  // Start the relay through the same bridge the Dashboard Start button uses.
  await startRelay(server.app)

  // Truthful health fields (controller.ts qbitHealth): relay online, qbit error.
  const health = (await server.app.serverBridge<Record<string, unknown>>('getHealth()')) as Record<
    string,
    unknown
  >
  expect(health['online']).toBe(true)
  const qbit = health['qbit'] as { state: string; detail: string | null }
  expect(qbit.state).toBe('error')
  expect(qbit.detail).toContain('not running')

  // Dashboard degraded-state surface: readiness row shows the qbit problem
  // while the online line still reports the relay as Online.
  await expect(server.app.page.getByTestId('status-qbittorrent')).toContainText('not running', {
    timeout: 15_000
  })
  await expect(server.app.page.getByTestId('online-line')).toContainText('Online')
})

test('FAIL-042: duplicate torrent — commit refuses when an UNMANAGED copy already exists in qBittorrent', async () => {
  server = await launchServer({
    testId: 'FAIL-042',
    qbitScenario: { files: SMALL_FILES },
    vikingOptions: { completeResponse: LOCAL_COMPLETE }
  })
  const client = await pairClient({ testId: 'FAIL-042', server })
  clients.push(client)

  // Construct the duplicate premise truthfully: the product only refuses at
  // commit when an existing torrent with the same infohash is NOT owned by
  // Viking Relay (no vr_job_* tag). Add one directly on the wire.
  const addRes = await fetch(`${server.qbit.url}/api/v2/torrents/add`, {
    method: 'POST',
    headers: {
      authorization: `Bearer e2e-qbit-key`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: 'urls=magnet%3A%3Fxt%3Durn%3Abtih%3A0123456789abcdef0123456789abcdef01234567'
  })
  expect(addRes.status).toBe(200)

  // Client intake + metadata succeed (mock serves metadata for the hash);
  // selection passes; COMMIT refuses with DuplicateUnmanagedTorrentError.
  await submitOnHome(client.app, E2E_MAGNET)
  await waitSelection(client.app, 'Movie 2024')
  await confirmSelectionAndStart(client.app)

  // Post-DEF-013 the download-kind failure falls through to message
  // heuristics → duplicate_torrent → title "Duplicate torrent".
  await client.app.waitFor(
    'terminal error screen after duplicate commit refusal',
    async () => {
      const h1 = await client.app.page.locator('h1').first().textContent().catch(() => null)
      return h1 === 'Duplicate torrent' || h1 === 'Something went wrong'
    },
    { timeoutMs: 30_000 }
  )
  await expect(client.app.page.getByText(/identical torrent already exists/i).first()).toBeVisible()
})
