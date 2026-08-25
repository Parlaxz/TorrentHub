import { test, expect } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { _electron } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  E2E_MAGNET,
  expectVisible,
  launchServer,
  pairClient,
  type PairedClient,
  type ServerCluster
} from './harness/cluster'
import { AppHandle } from './harness/app'
import { artifactRoot, makeTempUserData } from './harness/paths'
import type { QbitScenario } from './harness/qbit-server'
import type { MockVikingOptions } from '../viking/helpers/mock-server'

/**
 * HIST lane - docs/E2E-EXHAUSTIVE-TEST-PLAN.md SS HIST (HIST-001..015).
 * Permanent IDs; never renumber.
 *
 * DOCUMENTED DEVIATIONS / PLATFORM NOTES:
 *
 * 1. RESTART SEMANTICS (HIST-015): launchApp always allocates a FRESH temp
 *    userData dir, and the job history lives UNDER userData
 *    (<userData>/data/job-history.json, src/main/server/composition.ts) - NOT
 *    under settings.dataDir. A truthful "survives app restart" therefore
 *    re-seeds a new isolated dir with the EXACT persisted bytes
 *    (settings.json + data/job-history.json), the same boundary SANITY-002
 *    establishes for settings. Nothing is faked: the relaunched process reads
 *    only what the previous process durably wrote.
 *
 * 2. Client-side history Copy button (HIST-002) gives NO visual feedback by
 *    design (src/renderer/client/screens/HistoryScreen.tsx wires onClick
 *    straight to bridge.copyText). The truthful assertions are: the click
 *    produces no page errors and the SAME main-process clipboard bridge
 *    reports success.
 */

/* ------------------------------------------------------------------ */
/* cluster lifecycle                                                   */

let server: ServerCluster | null = null
let client: PairedClient | null = null
const extraApps: AppHandle[] = []
const localServers: Array<{ close(): Promise<void> }> = []

test.afterEach(async () => {
  if (client) {
    const c = client
    client = null
    await c.close().catch(() => undefined)
  }
  if (server) {
    const s = server
    server = null
    await s.close().catch(() => undefined)
  }
  for (const a of extraApps.splice(0)) {
    try {
      const proc = a.app.process()
      if (!proc || proc.exitCode !== null || proc.killed) continue
      await a.close().catch(() => undefined)
    } catch {
      /* already torn down */
    }
  }
  for (const s of localServers.splice(0)) await s.close().catch(() => undefined)
})

interface ClusterOptions {
  testId: string
  qbitScenario?: QbitScenario
  vikingOptions?: MockVikingOptions
  pair?: boolean
}

async function startCluster(opts: ClusterOptions): Promise<ServerCluster> {
  server = await launchServer({
    testId: opts.testId,
    label: 'server',
    qbitScenario: opts.qbitScenario,
    vikingOptions: opts.vikingOptions
  })
  if (opts.pair !== false) {
    client = await pairClient({ testId: opts.testId, server })
  }
  return server
}

/* ------------------------------------------------------------------ */
/* shared pipeline steps (proven core-journey patterns)                */

async function submitIntake(app: AppHandle, input: string): Promise<void> {
  await app.page.getByLabel('Torrent magnet link or URL').fill(input)
  await app.marker('submitting-intake', { input })
  await app.page.getByRole('button', { name: 'Continue' }).click()
}

async function reachSelectionScreen(app: AppHandle, torrentName: string): Promise<void> {
  await app.waitFor(`selection screen for "${torrentName}"`, async () => {
    return (
      (await app.page.getByRole('tree', { name: 'Torrent files' }).count()) > 0 &&
      (await app.page.getByText(torrentName, { exact: false }).count()) > 0
    )
  })
}

async function continueToPreflight(app: AppHandle): Promise<void> {
  await app.page.getByRole('button', { name: 'Continue' }).click()
  await app.waitFor('preflight verdict + Start button', async () => {
    const start = app.page.getByRole('button', { name: 'Start', exact: true })
    return (await start.count()) > 0 && start.first().isVisible()
  })
}

async function waitForCompleteScreen(app: AppHandle): Promise<string> {
  await app.waitFor(
    'CompleteScreen',
    async () => (await app.page.getByRole('heading', { name: 'Complete' }).count()) > 0,
    { timeoutMs: 60_000 }
  )
  await app.screenshot('complete-screen')
  return app.page.getByLabel('Viking URL').inputValue()
}

/** Runs the tiny mock torrent end-to-end from the paired client Home. */
async function runPipelineToComplete(app: AppHandle): Promise<string> {
  await submitIntake(app, E2E_MAGNET)
  await reachSelectionScreen(app, 'Movie 2024')
  await continueToPreflight(app)
  await app.page.getByRole('button', { name: 'Start', exact: true }).click()
  return waitForCompleteScreen(app)
}

interface SrvHistoryEntry {
  id: string
  name: string
  finalState: string
  url?: string | null
  directUrl?: string | null
  errorMessage?: string | null
  finishedAt: string
}

async function serverHistory(srv: ServerCluster): Promise<SrvHistoryEntry[]> {
  return srv.app.serverBridge<SrvHistoryEntry[]>('getHistory(20)')
}

async function waitForServerTerminal(srv: ServerCluster): Promise<SrvHistoryEntry> {
  await srv.app.waitFor('terminal job record in server history', async () => {
    return (await serverHistory(srv)).length > 0
  })
  const entries = await serverHistory(srv)
  return entries[0]
}

async function waitForErrorTitle(app: AppHandle, title: string, timeoutMs = 30_000): Promise<void> {
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

/* ------------------------------------------------------------------ */
/* restart machinery (see header note 1)                               */

function capturePersisted(app: AppHandle): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rel of ['settings.json', 'secrets.json', 'data/job-history.json']) {
    const raw = app.readPersisted(rel)
    if (raw !== null) out[rel] = raw
  }
  return out
}

interface LaunchSeededOptions {
  testId: string
  label: string
  /** Raw files written into the fresh userData dir before launch. */
  files?: Record<string, string>
  /** Extra env for the main process. */
  env?: Record<string, string>
}

async function launchSeeded(options: LaunchSeededOptions): Promise<AppHandle> {
  const root = join(artifactRoot(), options.testId)
  mkdirSync(root, { recursive: true })
  const userDataDir = makeTempUserData(options.label)
  for (const [rel, contents] of Object.entries(options.files ?? {})) {
    const target = join(userDataDir, ...rel.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, contents)
  }

  const app = await _electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: process.cwd(),
    env: { ...process.env, ...(options.env ?? {}) } as Record<string, string>
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const handle = new AppHandle(app, page, {
    userDataDir,
    artifactsDir: root,
    label: options.label
  })
  await handle.waitFor('shell bridge ready', async () => {
    try {
      return await page.evaluate(
        () =>
          window.vikingRelay
            ? window.vikingRelay.getState().then((s) => s.mode !== undefined)
            : false
      )
    } catch {
      return false
    }
  }, { timeoutMs: 20_000 })
  await handle.marker('launched-seeded', { label: options.label, userDataDir })
  return handle
}

/* ------------------------------------------------------------------ */
/* HIST-001..004 - client History screen                               */

test('HIST-001: client History screen lists the completed entry with name and state', async () => {
  await startCluster({ testId: 'HIST-001', qbitScenario: { downloadTicks: 2 } })
  const app = client!.app
  await runPipelineToComplete(app)

  await app.page.getByRole('button', { name: 'History' }).click()
  await expectVisible(app, 'Recent jobs')
  const item = app.page.locator('li').filter({ hasText: 'Movie 2024' }).first()
  await item.waitFor({ state: 'visible', timeout: 10_000 })
  await expect(item.getByText('Complete', { exact: true })).toBeVisible()
  await app.screenshot('hist-001-client-history-entry')
})

test('HIST-002: client history Copy button works through the clipboard bridge without errors', async () => {
  await startCluster({ testId: 'HIST-002', qbitScenario: { downloadTicks: 2 } })
  const app = client!.app
  await runPipelineToComplete(app)

  await app.page.getByRole('button', { name: 'History' }).click()
  const item = app.page.locator('li').filter({ hasText: 'Movie 2024' }).first()
  await item.waitFor({ state: 'visible', timeout: 10_000 })

  // No visual feedback exists on this control (header note 2); the truthful
  // contract is: click succeeds, no page errors, bridge clipboard write works.
  const errorsBefore = app.pageErrorCount()
  await item.getByRole('button', { name: 'Copy', exact: true }).click()
  await app.waitFor('no page errors after history Copy click', async () => {
    return app.pageErrorCount() === errorsBefore
  }, { timeoutMs: 3000 })
  const ok = await app.clientBridge<boolean>("copyText('HIST-002 clipboard probe')")
  expect(ok).toBe(true)
  await app.screenshot('hist-002-after-copy-click')
})

test('HIST-003: client history shows the empty state before any job exists', async () => {
  await startCluster({ testId: 'HIST-003' })
  const app = client!.app
  await app.waitFor('connected home', async () => {
    return (await app.page.getByLabel('Torrent magnet link or URL').count()) > 0
  })

  await app.page.getByRole('button', { name: 'History' }).click()
  await expectVisible(app, 'Recent jobs')
  await expectVisible(app, 'No jobs yet')
  await expectVisible(app, 'Submitted torrents will appear here.')
  expect(await app.page.getByRole('button', { name: 'Copy', exact: true }).count()).toBe(0)
  await app.screenshot('hist-003-empty-history')
})

test('HIST-004: client History Close returns to Home', async () => {
  await startCluster({ testId: 'HIST-004', qbitScenario: { downloadTicks: 2 } })
  const app = client!.app
  await runPipelineToComplete(app)

  await app.page.getByRole('button', { name: 'History' }).click()
  await expectVisible(app, 'Recent jobs')
  await app.page.getByRole('button', { name: 'Close', exact: true }).click()
  await app.waitFor('back on Home after Close', async () => {
    return (await app.page.getByLabel('Torrent magnet link or URL').count()) > 0
  })
  await app.screenshot('hist-004-back-on-home')
})

/* ------------------------------------------------------------------ */
/* HIST-010..013 - server Recent transfers actions                     */

test('HIST-010: server Recent transfers shows the completed entry with Complete label and timestamp', async () => {
  const srv = await startCluster({ testId: 'HIST-010', qbitScenario: { downloadTicks: 2 } })
  await runPipelineToComplete(client!.app)
  await waitForServerTerminal(srv)

  const card = srv.app.page.getByTestId('history')
  await card.getByText('Recent transfers').waitFor({ state: 'visible', timeout: 15_000 })
  await card.getByText('Movie 2024', { exact: false }).first().waitFor({ state: 'visible', timeout: 15_000 })
  await expect(card.getByText('Complete', { exact: true })).toBeVisible()
  const time = card.locator('time').first()
  await expect(time).toBeVisible()
  expect((await time.innerText()).trim().length).toBeGreaterThan(0)
  await srv.app.screenshot('hist-010-recent-transfers')
})

test('HIST-011: copy-link button copies the URL with Copied feedback', async () => {
  const srv = await startCluster({ testId: 'HIST-011', qbitScenario: { downloadTicks: 2 } })
  await runPipelineToComplete(client!.app)
  const entry = await waitForServerTerminal(srv)
  expect(entry.finalState).toBe('complete')

  const btn = srv.app.page.getByTestId(`copy-link-${entry.id}`)
  await btn.waitFor({ state: 'visible', timeout: 15_000 })
  await btn.click()
  await srv.app.waitFor('copy feedback shown on the entry button', async () => {
    return (await btn.innerText()).includes('Copied')
  }, { timeoutMs: 5000 })
  // The SAME main-process clipboard bridge the button wires to reports success.
  const ok = await srv.app.serverBridge<boolean>("copyText('HIST-011 clipboard probe')")
  expect(ok).toBe(true)
  await srv.app.screenshot('hist-011-copied-feedback')
})

test('HIST-012: open-link button resolves without page errors (shell handoff)', async () => {
  const srv = await startCluster({ testId: 'HIST-012', qbitScenario: { downloadTicks: 2 } })
  await runPipelineToComplete(client!.app)
  const entry = await waitForServerTerminal(srv)

  const btn = srv.app.page.getByTestId(`open-link-${entry.id}`)
  await btn.waitFor({ state: 'visible', timeout: 15_000 })
  const errorsBefore = srv.app.pageErrorCount()
  // shell.openExternal hands the LOCAL front URL to the OS browser; the side
  // effect is benign (same disposition as CORE-024).
  await btn.click()
  await srv.app.waitFor('no new page errors after Open click', async () => {
    return srv.app.pageErrorCount() === errorsBefore
  }, { timeoutMs: 3000 })
  await srv.app.screenshot('hist-012-after-open-click')
})

test('HIST-013: failed entry View cause toggles the error cause detail', async () => {
  test.setTimeout(150_000)
  // Local origin server for a direct-download intake whose UPLOAD will fail
  // permanently (viking session 403 is non-retryable -> terminal failed job).
  const payloadBytes = Buffer.alloc(64 * 1024, 3)
  const payloadSrv = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': payloadBytes.length,
      'content-disposition': 'attachment; filename="payload.bin"'
    })
    res.end(payloadBytes)
  })
  await new Promise<void>((resolve) => payloadSrv.listen(0, '127.0.0.1', resolve))
  const port = (payloadSrv.address() as AddressInfo).port
  localServers.push({
    close: () => new Promise<void>((res) => payloadSrv.close(() => res()))
  })

  const srv = await startCluster({
    testId: 'HIST-013',
    vikingOptions: { sessionOverride: () => ({ error: 'forbidden' }), sessionStatus: 403 }
  })
  const app = client!.app

  await submitIntake(app, `http://127.0.0.1:${port}/payload.bin`)
  await reachSelectionScreen(app, 'payload.bin')
  await continueToPreflight(app)
  await app.page.getByRole('button', { name: 'Start', exact: true }).click()
  await waitForErrorTitle(app, 'Viking upload failed')

  // Server history carries the failed entry WITH a human-readable cause.
  let failed: SrvHistoryEntry | null = null
  await srv.app.waitFor('failed entry with errorMessage in server history', async () => {
    const hit = (await serverHistory(srv)).find(
      (e) => e.finalState === 'failed' && !!e.errorMessage
    )
    failed = hit ?? null
    return Boolean(hit)
  }, { timeoutMs: 20_000 })
  const entry = failed as unknown as SrvHistoryEntry

  const card = srv.app.page.getByTestId('history')
  await expect(card.getByText('Failed', { exact: true })).toBeVisible()
  const causeBtn = srv.app.page.getByTestId(`view-cause-${entry.id}`)
  await causeBtn.waitFor({ state: 'visible', timeout: 10_000 })

  // Expand: cause detail becomes visible with the raw error message.
  await causeBtn.click()
  const cause = srv.app.page.getByTestId(`cause-${entry.id}`)
  await cause.waitFor({ state: 'visible', timeout: 5000 })
  expect((await cause.innerText()).trim().length).toBeGreaterThan(0)
  await srv.app.screenshot('hist-013-cause-expanded')

  // Collapse again.
  await causeBtn.click()
  await cause.waitFor({ state: 'hidden', timeout: 5000 })
})

/* ------------------------------------------------------------------ */
/* HIST-014..015 - archive / unarchive + restart persistence           */

test('HIST-014: Archive moves the entry out of Recent into Show archived; Unarchive restores it', async () => {
  const srv = await startCluster({ testId: 'HIST-014', qbitScenario: { downloadTicks: 2 } })
  await runPipelineToComplete(client!.app)
  const entry = await waitForServerTerminal(srv)
  const dash = srv.app.page

  // Archive: entry leaves Recent immediately.
  await dash.getByTestId(`archive-${entry.id}`).click()
  await dash
    .getByTestId('history')
    .getByText('No finished jobs yet.')
    .waitFor({ state: 'visible', timeout: 10_000 })
  await srv.app.screenshot('hist-014-recent-empty-after-archive')

  // Show archived: the entry is listed there with an Unarchive control.
  await dash.getByTestId('show-archived').check()
  const archivedCard = dash.getByTestId('history')
  await archivedCard.getByText('Archived transfers').waitFor({ state: 'visible', timeout: 10_000 })
  await archivedCard.getByText('Movie 2024', { exact: false }).first().waitFor({ state: 'visible', timeout: 10_000 })
  await expect(archivedCard.getByTestId(`unarchive-${entry.id}`)).toBeVisible()

  // Unarchive: leaves the archived view.
  await dash.getByTestId(`unarchive-${entry.id}`).click()
  await archivedCard.getByText('No archived jobs.').waitFor({ state: 'visible', timeout: 10_000 })

  // Back to Recent: the entry is listed again.
  await dash.getByTestId('show-archived').uncheck()
  await dash
    .getByTestId('history')
    .getByText('Movie 2024', { exact: false })
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
  await srv.app.screenshot('hist-014-restored-to-recent')
})

test('HIST-015: archived entries persist across a server app restart', async () => {
  test.setTimeout(240_000)
  const srv = await startCluster({ testId: 'HIST-015', qbitScenario: { downloadTicks: 2 } })
  await runPipelineToComplete(client!.app)
  const entry = await waitForServerTerminal(srv)

  // Archive it and observe the empty Recent list (archive took effect).
  const dash = srv.app.page
  await dash.getByTestId(`archive-${entry.id}`).click()
  await dash
    .getByTestId('history')
    .getByText('No finished jobs yet.')
    .waitFor({ state: 'visible', timeout: 10_000 })

  // Restart semantics (header note 1): re-seed a fresh isolated dir with the
  // EXACT bytes the old process durably wrote, then boot a new app on them.
  const captured = capturePersisted(srv.app)
  expect(captured['settings.json']).toBeTruthy()
  expect(captured['data/job-history.json']).toBeTruthy()

  await client!.close()
  client = null
  await srv.close()
  server = null

  const relaunched = await launchSeeded({
    testId: 'HIST-015',
    label: 'server-restarted',
    files: captured
  })
  extraApps.push(relaunched)
  expect((await relaunched.getState()).mode).toBe('server')

  // Archived flag survived: Show archived reveals the entry after restart.
  await relaunched.page.getByTestId('show-archived').check()
  const card = relaunched.page.getByTestId('history')
  await card.getByText('Archived transfers').waitFor({ state: 'visible', timeout: 15_000 })
  await card.getByText('Movie 2024', { exact: false }).first().waitFor({ state: 'visible', timeout: 15_000 })
  await expect(card.getByTestId(`unarchive-${entry.id}`)).toBeVisible()
  await relaunched.screenshot('hist-015-archived-after-restart')
})
