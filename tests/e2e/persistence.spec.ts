import { test, expect } from '@playwright/test'
import { _electron, type ElectronApplication } from 'playwright'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '../../src/shared/settings'
import { launchApp, AppHandle, seedSettingsFile } from './harness/app'
import {
  E2E_MAGNET,
  expectVisible,
  fillField,
  launchServer,
  pairClient,
  startRelay,
  type PairedClient,
  type ServerCluster
} from './harness/cluster'
import { artifactRoot, makeTempUserData } from './harness/paths'

/**
 * PERSIST lane - docs/E2E-EXHAUSTIVE-TEST-PLAN.md SS PERSIST
 * (PERSIST-001, 002, 010, 011, 012, 013, 020, 021, 022).
 * Permanent IDs; never renumber.
 *
 * DOCUMENTED DEVIATIONS / PLATFORM NOTES:
 *
 * 1. RESTART SEMANTICS: launchApp always allocates a FRESH temp userData dir.
 *    The job history lives UNDER userData (<userData>/data/job-history.json,
 *    src/main/server/composition.ts) - NOT under settings.dataDir - so
 *    "relaunch with the same dataDir" alone would NOT carry history. Every
 *    restart here therefore re-seeds a NEW isolated dir with the EXACT bytes
 *    the previous process durably wrote (settings.json + secrets.json +
 *    data/job-history.json) - the same persistence boundary SANITY-002
 *    establishes. The relaunched process reads only genuinely persisted state.
 *
 * 2. PERSIST-011: pipeline cleanup honors the flags observably (guarded qbit
 *    delete with deleteFiles=true; ZIP artifact removed from disk), but the
 *    per-job workspace DIR <dataDir>/jobs/jobs/<id> itself is NOT removed
 *    automatically (src/main/jobs/pipeline.ts cleanup removes only the zip +
 *    torrent; full jobDir removal exists only behind the explicit
 *    "Clean up job data" action, engine.discardArtifacts). The test asserts
 *    the honored contract truthfully and pins the remaining dir as a
 *    documented deviation from the plan wording.
 *
 * 3. PERSIST-020: dismissInterruptedJob persists record.dismissed=true
 *    (controller.ts), but getHistory() does not filter dismissed entries and
 *    Dashboard derives the banner from history[0].finalState==='interrupted'.
 *    The test asserts the intended behavior (banner clears) and will surface
 *    a product defect with evidence if it does not.
 */

/* ------------------------------------------------------------------ */
/* trackers + teardown                                                 */

const launched: AppHandle[] = []
const servers: ServerCluster[] = []
const clients: PairedClient[] = []
const extraDirs: string[] = []

async function closeAll(): Promise<void> {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined)
  for (const s of servers.splice(0)) {
    try {
      await s.close()
    } catch {
      /* app already torn down */
    }
  }
  for (const a of launched.splice(0)) {
    try {
      const proc = a.app.process()
      if (!proc || proc.exitCode !== null || proc.killed) continue
      await a.close().catch(() => undefined)
    } catch {
      /* already torn down */
    }
  }
  for (const d of extraDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

test.afterEach(async () => {
  await closeAll()
})

/* ------------------------------------------------------------------ */
/* restart machinery (header note 1)                                   */

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
  /** Reuse an existing directory instead of a fresh temp one. */
  userDataDir?: string
  /** Raw files written into the userData dir before launch. */
  files?: Record<string, string>
  /** Merged over DEFAULT_SETTINGS and written as settings.json. */
  settings?: Partial<AppSettings>
  env?: Record<string, string>
}

async function launchSeeded(options: LaunchSeededOptions): Promise<AppHandle> {
  const root = join(artifactRoot(), options.testId)
  mkdirSync(root, { recursive: true })
  const userDataDir = options.userDataDir ?? makeTempUserData(options.label)
  mkdirSync(userDataDir, { recursive: true })
  for (const [rel, contents] of Object.entries(options.files ?? {})) {
    const target = join(userDataDir, ...rel.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, contents)
  }
  if (options.settings) seedSettingsFile(userDataDir, options.settings)

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

function readJobRecordsFrom(app: AppHandle): Array<Record<string, unknown>> {
  const raw = app.readPersisted('data/job-history.json')
  if (!raw) return []
  try {
    return ((JSON.parse(raw) as { jobs?: Array<Record<string, unknown>> }).jobs ?? []) as Array<
      Record<string, unknown>
    >
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/* window/process helpers (lifecycle.spec patterns)                    */

type WinHandle = Awaited<ReturnType<ElectronApplication['browserWindow']>>

async function windowVisible(win: WinHandle): Promise<boolean> {
  return win.evaluate((w) => (w as { isVisible(): boolean }).isVisible())
}

/** Triggers the REAL user close path (BrowserWindow.close emits 'close'). */
async function closeWindow(win: WinHandle): Promise<void> {
  await win.evaluate((w) => (w as { close(): void }).close())
}

function waitForProcessExit(handle: AppHandle, timeoutMs = 20_000): Promise<number | null> {
  const proc = handle.app.process()
  // NOTE: do NOT short-circuit on proc.killed — kill() sets the flag before
  // the exit code exists, which would resolve a premature null.
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.off('exit', onExit)
      resolve(null)
    }, timeoutMs)
    const onExit = (code: number | null): void => {
      clearTimeout(timer)
      resolve(code)
    }
    proc.once('exit', onExit)
  })
}

/* ------------------------------------------------------------------ */
/* shared pipeline steps (proven core-journey patterns)                */

interface SrvHistoryEntry {
  id: string
  name: string
  finalState: string
  url?: string | null
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

async function submitIntake(app: AppHandle, input: string): Promise<void> {
  await app.page.getByLabel('Torrent magnet link or URL').fill(input)
  await app.marker('submitting-intake', { input })
  await app.page.getByRole('button', { name: 'Continue' }).click()
}

async function reachSelectionScreen(app: AppHandle): Promise<void> {
  await app.waitFor('selection screen with torrent file tree', async () => {
    return (await app.page.getByRole('tree', { name: 'Torrent files' }).count()) > 0
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
  await reachSelectionScreen(app)
  await continueToPreflight(app)
  await app.page.getByRole('button', { name: 'Start', exact: true }).click()
  return waitForCompleteScreen(app)
}

/* ------------------------------------------------------------------ */
/* PERSIST-001 / PERSIST-002                                           */

test('PERSIST-001: chosen mode persists across restart (seeded settings bytes)', async () => {
  const first = await launchApp({ testId: 'PERSIST-001', label: 'first', keepUserDataOnClose: true })
  launched.push(first)
  await first.page.getByRole('button', { name: /Server PC/ }).click()
  await first.waitFor('mode switched to server', async () => (await first.getState()).mode === 'server')
  await first.close()

  // Restart semantics: re-seed a new isolated dir with the exact persisted bytes.
  const settingsJson = first.readPersisted('settings.json')
  expect(settingsJson).toBeTruthy()
  expect(JSON.parse(settingsJson!)['mode']).toBe('server')

  const restarted = await launchSeeded({
    testId: 'PERSIST-001',
    label: 'restarted',
    files: { 'settings.json': settingsJson! }
  })
  launched.push(restarted)
  expect((await restarted.getState()).mode).toBe('server')
  // Server mode without a working folder lands on the setup wizard.
  await expect(restarted.page.getByRole('heading', { name: 'Working folder' })).toBeVisible()
})

test('PERSIST-002: minimizeToTrayOnClose=false makes window close really quit the process', async () => {
  const app = await launchApp({
    testId: 'PERSIST-002',
    label: 'no-tray',
    settings: { minimizeToTrayOnClose: false }
  })
  launched.push(app)
  await app.page.getByRole('button', { name: /Client PC/ }).click()
  await app.waitFor('mode switched to client', async () => (await app.getState()).mode === 'client')

  const win = await app.app.browserWindow(app.page)
  await app.waitFor('main window shown', async () => windowVisible(win))
  await closeWindow(win)

  // With tray residency disabled the close must be a REAL clean exit.
  const code = await waitForProcessExit(app, 20_000)
  expect(code).not.toBeNull()
  expect(code).toBe(0)
})

/* ------------------------------------------------------------------ */
/* PERSIST-010..012 - completed job vs restart / cleanup / format      */

test('PERSIST-010: completed job survives a server app restart (history JSON reloaded)', async () => {
  test.setTimeout(300_000)
  const srv = await launchServer({
    testId: 'PERSIST-010',
    label: 'server',
    qbitScenario: { downloadTicks: 2 }
  })
  servers.push(srv)
  const client = await pairClient({ testId: 'PERSIST-010', server: srv })
  clients.push(client)

  const url = await runPipelineToComplete(client.app)
  const entry = await waitForServerTerminal(srv)
  expect(entry.finalState).toBe('complete')
  expect(entry.url).toBe(url)

  // Capture EVERYTHING the old process durably wrote (header note 1).
  const captured = capturePersisted(srv.app)
  expect(captured['settings.json']).toBeTruthy()
  expect(captured['data/job-history.json']).toBeTruthy()

  await client.close()
  clients.pop()
  await srv.close()
  servers.pop()

  const relaunched = await launchSeeded({
    testId: 'PERSIST-010',
    label: 'server-relaunch',
    files: captured
  })
  launched.push(relaunched)
  expect((await relaunched.getState()).mode).toBe('server')

  // Arrange-only secret provisioning through the SAME IPC the SettingsPanel
  // uses (mirrors cluster.launchServer on every server boot).
  await relaunched.serverBridge<boolean>("setQbitApiKey('e2e-qbit-key')")
  await startRelay(relaunched)

  // The completed record is back in the bridge history after the restart...
  const hist = await serverHistoryOf(relaunched)
  const restored = hist.find((e) => e.id === entry.id)
  expect(restored).toBeDefined()
  expect(restored!.finalState).toBe('complete')
  expect(restored!.url).toBe(url)

  // ...and the Dashboard renders it under Recent transfers.
  const card = relaunched.page.getByTestId('history')
  await card.getByText('Recent transfers').waitFor({ state: 'visible', timeout: 15_000 })
  await card.getByText('Movie 2024', { exact: false }).first().waitFor({ state: 'visible', timeout: 15_000 })
  await expect(card.getByText('Complete', { exact: true })).toBeVisible()
  await relaunched.screenshot('persist-010-after-restart')
})

async function serverHistoryOf(app: AppHandle): Promise<SrvHistoryEntry[]> {
  return app.serverBridge<SrvHistoryEntry[]>('getHistory(20)')
}

test('PERSIST-011: cleanup flags honored - guarded delete issued and ZIP removed from disk', async () => {
  test.setTimeout(240_000)
  const srv = await launchServer({ testId: 'PERSIST-011', label: 'server' })
  servers.push(srv)
  const client = await pairClient({ testId: 'PERSIST-011', server: srv })
  clients.push(client)

  // Default multi-file fixture -> zipRequired=true -> a real ZIP is created.
  await runPipelineToComplete(client.app)
  const entry = await waitForServerTerminal(srv)
  expect(entry.finalState).toBe('complete')

  const records = readJobRecordsFrom(srv.app)
  const rec = records.find((r) => r['id'] === entry.id)
  expect(rec).toBeDefined()
  expect(rec!['stages'] && (rec!['stages'] as Record<string, string>)['cleanup']).toBe('complete')

  // Flag consequence #1 (wire-level): guarded delete WITH file deletion.
  const deletes = srv.qbit.requests.filter((r) => r.path === '/api/v2/torrents/delete')
  expect(deletes.length).toBeGreaterThanOrEqual(1)
  expect(deletes.some((d) => d.bodyPreview.includes('deleteFiles=true'))).toBe(true)

  // Flag consequence #2 (on disk): the uploaded ZIP artifact is gone.
  const zipPath = rec!['zipPath']
  expect(typeof zipPath).toBe('string')
  await srv.app.waitFor('zip artifact removed from disk', async () => !existsSync(String(zipPath)))

  // DOCUMENTED DEVIATION (header note 2): the per-job workspace dir itself
  // remains until the explicit "Clean up job data" action; only zip + torrent
  // are removed by the automatic cleanup stage.
  const jobDir = rec!['jobDir']
  expect(typeof jobDir).toBe('string')
  expect(existsSync(String(jobDir))).toBe(true)
  await srv.app.screenshot('persist-011-cleanup-checked')
})

test('PERSIST-012: history JSON is the atomic versioned format {version:1,jobs:[...]}', async () => {
  test.setTimeout(240_000)
  const srv = await launchServer({
    testId: 'PERSIST-012',
    label: 'server',
    qbitScenario: { downloadTicks: 2 }
  })
  servers.push(srv)
  const client = await pairClient({ testId: 'PERSIST-012', server: srv })
  clients.push(client)

  await runPipelineToComplete(client.app)
  await waitForServerTerminal(srv)

  const raw = srv.app.readPersisted('data/job-history.json')
  expect(raw).toBeTruthy()
  // Parses cleanly = the temp+rename atomic write never left a torn file.
  const parsed = JSON.parse(raw!) as Record<string, unknown>
  expect(parsed['version']).toBe(1)
  expect(Array.isArray(parsed['jobs'])).toBe(true)
  const jobs = parsed['jobs'] as Array<Record<string, unknown>>
  expect(jobs.length).toBeGreaterThanOrEqual(1)
  for (const j of jobs) {
    expect(typeof j['id']).toBe('string')
    expect(typeof j['state']).toBe('string')
  }
  // No leftover temp file next to the store.
  expect(existsSync(join(srv.app.userDataDir, 'data', 'job-history.json.tmp'))).toBe(false)
  // Plan cap note: the <=100 entry cap is enforced by JsonJobRepository; not
  // cheaply assertable without 100+ jobs - format + shape asserted instead.
})

/* ------------------------------------------------------------------ */
/* PERSIST-013 - secrets survive restart                               */

test('PERSIST-013: paired client reconnects after restart WITHOUT re-pairing (secrets survive)', async () => {
  test.setTimeout(240_000)
  const srv = await launchServer({ testId: 'PERSIST-013', label: 'server' })
  servers.push(srv)

  // Pair through the REAL ConnectScreen UI.
  const generated = (await srv.app.serverBridge<Record<string, unknown>>(
    'generatePairingCode()'
  )) as Record<string, unknown>
  const code =
    typeof generated['code'] === 'string'
      ? generated['code']
      : String(generated['pairingCode'] ?? '')
  expect(code.length).toBeGreaterThan(0)

  const first = await launchApp({
    testId: 'PERSIST-013',
    label: 'client-1',
    keepUserDataOnClose: true,
    settings: { mode: 'client' }
  })
  launched.push(first)
  await expectVisible(first, 'Pair & Connect')
  await fillField(first.page, 'Server IP', srv.relayAddress)
  await fillField(first.page, 'Port', String(srv.relayPort))
  await fillField(first.page, 'Pairing Code', code)
  await first.page.getByRole('button', { name: /Pair & Connect/ }).click()
  await first.waitFor('client paired', async () => {
    try {
      const conn = (await first.clientBridge<{ host?: string } | null>('getConnection()')) as {
        host?: string
      } | null
      return Boolean(conn && conn.host)
    } catch {
      return false
    }
  }, { timeoutMs: 20_000 })

  // Capture settings + DPAPI-encrypted secrets, then restart on the SAME
  // userData dir: Electron safeStorage ciphertext is bound to the userData
  // directory, so copying secrets.json elsewhere breaks decryption. A real
  // user's restart always reuses the same directory.
  void capturePersisted(first)
  await first.close()

  const relaunched = await launchApp({
    testId: 'PERSIST-013',
    label: 'client-2',
    keepUserDataOnClose: true,
    userDataDir: first.userDataDir
  })
  launched.push(relaunched)

  // Lands straight on Home - no Connect screen, no re-pairing.
  await relaunched.waitFor('home without re-pairing', async () => {
    return (await relaunched.page.getByLabel('Torrent magnet link or URL').count()) > 0
  })
  expect(await relaunched.page.getByRole('button', { name: /Pair & Connect/ }).count()).toBe(0)
  const conn = (await relaunched.clientBridge<{ host?: string } | null>('getConnection()')) as {
    host?: string
  } | null
  expect(conn && conn.host).toBe(srv.relayAddress)

  // The restored bearer token actually AUTHENTICATES against the live server
  // (connectionStatus probes /v1/server/status with it).
  await relaunched.waitFor('authenticated status via restored token', async () => {
    const s = (await relaunched.clientBridge<{ state?: string }>('connectionStatus()')) as {
      state?: string
    }
    return s.state === 'connected'
  }, { timeoutMs: 20_000 }).catch(async (err) => {
    console.log('P013 DUMP state:', await relaunched.clientBridge('connectionStatus().then(s => String(s && s.state))'))
    console.log('P013 DUMP conn.host:', await relaunched.clientBridge('getConnection().then(c => c ? String(c.host) : "null")'))
    console.log('P013 DUMP secrets present:', relaunched.readPersisted('secrets.json') !== null)
    throw err
  })
  await relaunched.screenshot('persist-013-reconnected')
})

/* ------------------------------------------------------------------ */
/* PERSIST-020 / PERSIST-021 - interrupted sweep + cancelled stability */

test('PERSIST-020: kill mid-job then restart shows interrupted banner; Dismiss acknowledges', async () => {
  test.setTimeout(300_000)
  const srv = await launchServer({
    testId: 'PERSIST-020',
    label: 'server',
    qbitScenario: { downloadTicks: 30 }
  })
  servers.push(srv)
  const client = await pairClient({ testId: 'PERSIST-020', server: srv })
  clients.push(client)

  await submitIntake(client.app, E2E_MAGNET)
  await reachSelectionScreen(client.app)
  await continueToPreflight(client.app)
  await client.app.page.getByRole('button', { name: 'Start', exact: true }).click()

  // Wait until the transfer is genuinely mid-flight, then HARD-kill the server.
  await srv.app.waitFor('job downloading', async () => {
    const job = (await srv.app.serverBridge<Record<string, unknown> | null>('getActiveJob()')) as
      | Record<string, unknown>
      | null
    return job !== null && job['state'] === 'downloading'
  }, { timeoutMs: 30_000 })
  // Hard-kill the whole process tree: proc.kill() may target a shell wrapper
  // rather than electron itself, orphaning the app.
  const { execSync } = require('node:child_process') as typeof import('node:child_process')
  try {
    execSync(`taskkill /PID ${srv.app.app.process().pid} /T /F`, { stdio: 'ignore' })
  } catch {
    srv.app.app.process().kill()
  }
  const killCode = await waitForProcessExit(srv.app, 15_000)
  expect(killCode).not.toBeNull()

  // The killed process durably wrote its nonterminal record before dying.
  const captured = capturePersisted(srv.app)
  expect(captured['data/job-history.json']).toBeTruthy()

  await client.close()
  clients.pop()

  // Restart on the exact persisted bytes; startupSweep must mark interrupted.
  const relaunched = await launchSeeded({
    testId: 'PERSIST-020',
    label: 'server-relaunch',
    files: captured
  })
  launched.push(relaunched)
  await relaunched.serverBridge<boolean>("setQbitApiKey('e2e-qbit-key')")
  await startRelay(relaunched)

  const banner = relaunched.page.getByTestId('interrupted-banner')
  await banner.waitFor({ state: 'visible', timeout: 30_000 })
  await relaunched.screenshot('persist-020-interrupted-banner')

  // Dismiss persists the acknowledgment on the record. FLAKE GUARD: live
  // health pushes (1/s) change the StorageCard figures above the banner,
  // shifting sibling buttons horizontally — a click can land on the adjacent
  // "Clean up job data". Verify the effect and re-click if needed.
  let dismissed = false
  for (let attempt = 0; attempt < 4 && !dismissed; attempt++) {
    const btn = banner.getByRole('button', { name: 'Dismiss', exact: true })
    if ((await btn.count()) > 0) await btn.click()
    try {
      await relaunched.waitFor(
        'dismissed flag persisted',
        async () => {
          const rec = readJobRecordsFrom(relaunched).find((r) => r['state'] === 'interrupted')
          return Boolean(rec && rec['dismissed'] === true)
        },
        { timeoutMs: 4000 }
      )
      dismissed = true
    } catch {
      /* re-click */
    }
  }
  expect(dismissed, 'dismissed flag persisted after retries').toBe(true)

  // ...and the intended UX contract: the banner clears afterwards.
  let cleared = true
  try {
    await relaunched.waitFor(
      'interrupted banner clears after Dismiss',
      async () => (await relaunched.page.getByTestId('interrupted-banner').count()) === 0,
      { timeoutMs: 8000 }
    )
  } catch {
    cleared = false
  }
  await relaunched.screenshot('persist-020-after-dismiss')
  expect(
    cleared,
    'SUSPECTED PRODUCT DEFECT: dismissInterruptedJob sets record.dismissed=true but getHistory() does not filter dismissed entries, so Dashboard keeps deriving the banner from history[0].finalState==="interrupted" and the banner never clears.'
  ).toBe(true)
})

test('PERSIST-021: job cancelled before a restart stays cancelled after the restart', async () => {
  test.setTimeout(300_000)
  const srv = await launchServer({
    testId: 'PERSIST-021',
    label: 'server',
    qbitScenario: { downloadTicks: 8 }
  })
  servers.push(srv)
  const client = await pairClient({ testId: 'PERSIST-021', server: srv })
  clients.push(client)

  await submitIntake(client.app, E2E_MAGNET)
  await reachSelectionScreen(client.app)
  await continueToPreflight(client.app)
  await client.app.page.getByRole('button', { name: 'Start', exact: true }).click()
  await client.app.waitFor('active job screen visible', async () => {
    return (await client!.app.page.getByText('UPLOAD TO VIKING').count()) > 0
  }, { timeoutMs: 30_000 })

  await client.app.page.getByRole('button', { name: 'Cancel job' }).click()
  await client.app.waitFor('back on Home after cancel', async () => {
    return (await client!.app.page.getByLabel('Torrent magnet link or URL').count()) > 0
  })
  const entry = await waitForServerTerminal(srv)
  expect(entry.finalState).toBe('cancelled')

  const captured = capturePersisted(srv.app)
  await client.close()
  clients.pop()
  await srv.close()
  servers.pop()

  const relaunched = await launchSeeded({
    testId: 'PERSIST-021',
    label: 'server-relaunch',
    files: captured
  })
  launched.push(relaunched)
  await relaunched.serverBridge<boolean>("setQbitApiKey('e2e-qbit-key')")
  await startRelay(relaunched)

  const hist = await serverHistoryOf(relaunched)
  const restored = hist.find((e) => e.id === entry.id)
  expect(restored).toBeDefined()
  expect(restored!.finalState).toBe('cancelled')
  const card = relaunched.page.getByTestId('history')
  await card.getByText('Cancelled', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await relaunched.screenshot('persist-021-cancelled-after-restart')
})

/* ------------------------------------------------------------------ */
/* PERSIST-022 - corrupt settings fail-safe                            */

test('PERSIST-022: corrupt settings.json boots on defaults and is rewritten valid on first change', async () => {
  const corruptDir = makeTempUserData('persist022-corrupt')
  extraDirs.push(corruptDir)
  writeFileSync(join(corruptDir, 'settings.json'), 'THIS IS NOT JSON {{{')

  const app = await launchSeeded({
    testId: 'PERSIST-022',
    label: 'corrupt-boot',
    userDataDir: corruptDir
  })
  launched.push(app)

  // Fails safe: defaults loaded, first-run chooser shown.
  await expect(app.page.getByText('Welcome to Viking Relay')).toBeVisible()
  expect((await app.getState()).mode).toBeNull()

  // First settings change rewrites the file as valid JSON.
  await app.page.getByRole('button', { name: /Client PC/ }).click()
  await app.waitFor('mode switched to client', async () => (await app.getState()).mode === 'client')
  await app.waitFor('settings.json rewritten valid', async () => {
    const raw = app.readPersisted('settings.json')
    if (raw === null) return false
    try {
      return JSON.parse(raw)['mode'] === 'client'
    } catch {
      return false
    }
  })
  await app.screenshot('persist-022-recovered')
})
