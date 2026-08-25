import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { ElectronApplication, JSHandle } from 'playwright'
import { launchApp, type AppHandle } from './harness/app'
import { launchServer, type ServerCluster } from './harness/cluster'

/**
 * LIFE / NAV lane — docs/E2E-EXHAUSTIVE-TEST-PLAN.md §LIFE/NAV.
 *
 * Platform-limitation pattern (win32 tray): Playwright cannot click native
 * tray menus. Tray EXISTENCE is asserted truthfully via the absence of the
 * main-process warning "tray icon unavailable" in the pino log file; the
 * tray-menu-click sub-steps are covered by driving the SAME terminal code
 * paths the tray handlers run (`quitting = true; app.quit()` via
 * requestAppExit(), `mainWindow.show()` via the second-instance signal).
 * Nothing here fakes a tray click.
 */

const launched: AppHandle[] = []
const servers: ServerCluster[] = []

async function closeAll(): Promise<void> {
  for (const s of servers) {
    try {
      await s.close()
    } catch {
      /* app already torn down */
    }
  }
  servers.length = 0
  for (const a of launched) {
    try {
      // Harness gap: AppHandle.close() crashes on an already-exited process
      // (app.process() returns undefined). Skip those — they exited cleanly
      // by design (tray-exit / real-close paths).
      const proc = a.app.process()
      if (!proc || proc.killed || proc.exitCode !== null) continue
      await a.close()
    } catch {
      /* already torn down */
    }
  }
  launched.length = 0
}

test.afterEach(async () => {
  await closeAll()
})

/* ------------------------------------------------------------------ */
/* helpers                                                             */

type WinHandle = Awaited<ReturnType<ElectronApplication['browserWindow']>>

async function windowVisible(win: WinHandle): Promise<boolean> {
  return win.evaluate((w) => (w as { isVisible(): boolean }).isVisible())
}

/** Triggers the REAL user close path: BrowserWindow.close() emits 'close',
 *  which main intercepts (hide-to-tray) or lets through (real exit). */
async function closeWindow(win: WinHandle): Promise<void> {
  await win.evaluate((w) => (w as { close(): void }).close())
}

/** Bounded poll for process exit. Resolves the exit code, or null on deadline. */
function waitForProcessExit(handle: AppHandle, timeoutMs = 20_000): Promise<number | null> {
  const proc = handle.app.process()
  if (proc.exitCode !== null || proc.killed) return Promise.resolve(proc.exitCode)
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

/**
 * Truthful tray-existence check: createTray() logs "tray icon unavailable"
 * when the tray could not be created (src/main/index.ts). Wait until the
 * startup line is flushed to disk, then assert the warning is ABSENT.
 * NOTE: the logger writes a DATE-STAMPED file (logger.ts):
 * logs/viking-relay-YYYY-MM-DD.log.
 */
async function assertTrayCreated(handle: AppHandle): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  const logPath = join('logs', `viking-relay-${today}.log`)
  await handle.waitFor('startup log flushed to disk', async () => {
    const log = handle.readPersisted(logPath)
    return log !== null && log.includes('Viking Relay starting')
  })
  const log = handle.readPersisted(logPath) ?? ''
  expect(
    log.includes('tray icon unavailable'),
    'tray must be created on win32 — found "tray icon unavailable" warning in main log'
  ).toBe(false)
}

/* ------------------------------------------------------------------ */
/* LIFE-001..004 — mode chooser + header badge                         */

test('LIFE-001: fresh launch shows chooser with correct versions', async () => {
  const app = await launchApp({ testId: 'LIFE-001', label: 'fresh' })
  launched.push(app)
  await app.marker('assert-chooser')
  await expect(app.page.getByText('Welcome to Viking Relay')).toBeVisible()
  const state = await app.getState()
  expect(state.mode).toBeNull()
  expect(state.versions.app).toBe('0.4.3')
  expect(state.versions.electron).toMatch(/^\d+\./)
  expect(state.versions.chrome).toMatch(/^\d+\./)
  expect(state.versions.node).toMatch(/^\d+\./)
})

test('LIFE-002: choose Client mounts the client app', async () => {
  const app = await launchApp({ testId: 'LIFE-002', label: 'client' })
  launched.push(app)
  await app.page.getByRole('button', { name: /Client PC/ }).click()
  await app.waitFor('mode switched to client', async () => (await app.getState()).mode === 'client')
  // Client app mounted: fresh client lands on the Connect screen.
  await expect(app.page.getByRole('button', { name: /Pair & Connect/ })).toBeVisible()
})

test('LIFE-003: choose Server mounts the server app (first-run wizard)', async () => {
  const app = await launchApp({ testId: 'LIFE-003', label: 'server' })
  launched.push(app)
  await app.page.getByRole('button', { name: /Server PC/ }).click()
  await app.waitFor('mode switched to server', async () => (await app.getState()).mode === 'server')
  // Server app mounted: no working folder yet ⇒ SetupWizard step 1.
  await expect(app.page.getByRole('heading', { name: 'Working folder' })).toBeVisible()
})

test('LIFE-004: header badge reflects mode (unconfigured/client/server)', async () => {
  const app = await launchApp({ testId: 'LIFE-004', label: 'badge' })
  launched.push(app)
  const badge = app.page.locator('header span.font-mono')
  await expect(badge).toHaveText('unconfigured')
  await app.page.getByRole('button', { name: /Client PC/ }).click()
  await app.waitFor('badge=client', async () => (await app.getState()).mode === 'client')
  await expect(badge).toHaveText('client')
  await app.page.getByRole('button', { name: 'Switch mode' }).click()
  await app.waitFor('badge=server', async () => (await app.getState()).mode === 'server')
  await expect(badge).toHaveText('server')
})

/* ------------------------------------------------------------------ */
/* LIFE-005..007 — tray residency                                      */

test('LIFE-005: window close hides to tray (process alive, window hidden)', async () => {
  const app = await launchApp({ testId: 'LIFE-005', label: 'tray-hide' })
  launched.push(app)
  const win = await app.app.browserWindow(app.page)
  await app.waitFor('main window shown', async () => windowVisible(win))

  await closeWindow(win)

  await app.waitFor('window hidden after close (hide-to-tray)', async () => {
    return !(await windowVisible(win))
  })
  expect(app.app.process().killed).toBe(false)
  expect(app.app.process().exitCode).toBeNull()
  // Bridge still answers — the app is resident, not half-dead.
  expect((await app.getState()).mode).toBeNull()
})

test('LIFE-006: tray Exit quits the process cleanly (covered-by-exit-flow)', async () => {
  // PLATFORM LIMITATION: the native tray context menu cannot be automated on
  // win32. The tray Exit item runs exactly `quitting = true; app.quit()`
  // (createTray in src/main/index.ts); requestAppExit() reaches the identical
  // terminal path through main. This test asserts tray existence truthfully,
  // then drives that shared quit path and requires a CLEAN process exit.
  const app = await launchApp({ testId: 'LIFE-006', label: 'tray-exit' })
  launched.push(app)
  await assertTrayCreated(app)

  // The quit tears the page down before the invoke reply can arrive — the
  // rejection IS the success signal here; the assertion is the clean exit.
  try {
    await app.serverBridge<unknown>('requestAppExit()')
  } catch {
    /* page torn down by the quit this call triggered */
  }

  const code = await waitForProcessExit(app)
  expect(code).not.toBeNull()
  expect(code).toBe(0)
})

test('LIFE-007: re-show after tray hide via second-instance signal (Open Viking Relay equivalent)', async () => {
  // PLATFORM LIMITATION: the tray items "Open Viking Relay" and the static
  // "Status: idle/transferring" label live in a native win32 menu Playwright
  // cannot drive. Re-show is verified through the real second-instance
  // product path, whose handler performs the SAME mainWindow.show() (+restore
  // +focus) as the tray Open item. The status-label text itself is
  // dispositioned as not automatable (native menu), not faked.
  const first = await launchApp({ testId: 'LIFE-007', label: 'primary' })
  launched.push(first)
  await assertTrayCreated(first)

  const win = await first.app.browserWindow(first.page)
  await closeWindow(win)
  await first.waitFor('window hidden to tray', async () => !(await windowVisible(win)))

  // A second instance sharing the userData dir hits the single-instance lock;
  // the FIRST instance receives 'second-instance' → mainWindow.show().
  // Spawned directly (no Playwright loader): the second instance self-quits
  // via the lock, which tears down any Playwright attach handshake.
  const electronBinary = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
  const second = spawn(electronBinary, ['.', `--user-data-dir=${first.userDataDir}`], {
    cwd: process.cwd(),
    stdio: 'ignore'
  })
  try {
    await first.waitFor('window re-shown by second-instance signal', async () => windowVisible(win), {
      timeoutMs: 45_000
    })
  } finally {
    if (second.exitCode === null && !second.killed) second.kill()
  }
  expect(await windowVisible(win)).toBe(true)
  expect(first.app.process().exitCode).toBeNull()
})

/* ------------------------------------------------------------------ */
/* LIFE-010..011 — exit confirmation + hidden launch                   */

test('LIFE-010: server exit button → confirm dialog; cancel keeps alive, confirm exits cleanly', async () => {
  const cluster = await launchServer({ testId: 'LIFE-010', label: 'server', skipAutoStart: true })
  servers.push(cluster)
  const app = cluster.app

  await expect(app.page.getByTestId('exit-button')).toBeVisible({ timeout: 20_000 })

  // Cancel path: dialog opens, "Keep running" closes it, process stays alive.
  await app.page.getByTestId('exit-button').click()
  const dialog = app.page.getByRole('dialog', { name: /Exit Viking Relay\?/ })
  await expect(dialog).toBeVisible()
  await app.page.getByTestId('exit-cancel').click()
  await expect(dialog).toBeHidden()
  expect(app.app.process().exitCode).toBeNull()
  expect((await app.getState()).mode).toBe('server')

  // Confirm path: "Exit anyway" → requestAppExit → quitting=true; app.quit().
  // The quit can tear down the page while Playwright finishes the click's
  // post-conditions, so tolerate a closed-target error here.
  await app.page.getByTestId('exit-button').click()
  await expect(dialog).toBeVisible()
  try {
    await app.page.getByTestId('exit-confirm').click()
  } catch {
    /* page torn down by the quit this click triggered */
  }

  const code = await waitForProcessExit(app)
  expect(code).not.toBeNull()
  expect(code).toBe(0)
})

test('LIFE-011: --hidden launch starts with no visible window (login-item path)', async () => {
  const app = await launchApp({ testId: 'LIFE-011', label: 'hidden', hidden: true })
  launched.push(app)
  // Bridge answers even though the window never showed.
  const state = await app.getState()
  expect(state.mode).toBeNull()
  for (const page of app.app.windows()) {
    const win = await app.app.browserWindow(page)
    expect(await windowVisible(win), 'no window may be visible on --hidden launch').toBe(false)
  }
  expect(app.app.process().exitCode).toBeNull()
})

/* ------------------------------------------------------------------ */
/* NAV-001..002 — mode switching                                       */

test('NAV-001: client→server→client round trip preserves both backends', async () => {
  const app = await launchApp({ testId: 'NAV-001', label: 'roundtrip' })
  launched.push(app)

  await app.page.getByRole('button', { name: /Client PC/ }).click()
  await app.waitFor('client mount 1', async () => (await app.getState()).mode === 'client')
  await expect(app.page.getByRole('button', { name: /Pair & Connect/ })).toBeVisible()

  await app.page.getByRole('button', { name: 'Switch mode' }).click()
  await app.waitFor('server mount', async () => (await app.getState()).mode === 'server')
  await expect(app.page.getByRole('heading', { name: 'Working folder' })).toBeVisible()

  await app.page.getByRole('button', { name: 'Switch mode' }).click()
  await app.waitFor('client mount 2', async () => (await app.getState()).mode === 'client')
  await expect(app.page.getByRole('button', { name: /Pair & Connect/ })).toBeVisible()

  // Both backends still answer after the round trip.
  const conn = await app.clientBridge<unknown>('getConnection()')
  expect(conn === null || typeof conn === 'object').toBe(true)
  const serverSettings = await app.serverBridge<Record<string, unknown>>('getSettings()')
  expect(serverSettings).toBeTruthy()

  // Final choice persisted.
  await app.waitFor('persisted mode=client', async () => {
    const raw = app.readPersisted('settings.json')
    return raw !== null && JSON.parse(raw)['mode'] === 'client'
  })
})

test('NAV-002: switching during an active client screen mounts server directly (no chooser)', async () => {
  const app = await launchApp({ testId: 'NAV-002', label: 'switch-active' })
  launched.push(app)

  await app.page.getByRole('button', { name: /Client PC/ }).click()
  await expect(app.page.getByRole('button', { name: /Pair & Connect/ })).toBeVisible()

  await app.page.getByRole('button', { name: 'Switch mode' }).click()
  await app.waitFor('server mounted', async () => (await app.getState()).mode === 'server')

  // Chooser-free mount: the welcome chooser must NOT be rendered…
  await expect(app.page.getByText('Welcome to Viking Relay')).toHaveCount(0)
  // …and the server surface is up instead.
  await expect(app.page.getByRole('heading', { name: 'Working folder' })).toBeVisible()
})
