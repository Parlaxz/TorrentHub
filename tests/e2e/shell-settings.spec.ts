import { test, expect, type Locator } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, type AppHandle } from './harness/app'
import { makeTempUserData } from './harness/paths'

/**
 * UI (shell / global settings) + SET (server SettingsPanel) lanes —
 * docs/E2E-EXHAUSTIVE-TEST-PLAN.md §UI shell, §SET.
 */

const launched: AppHandle[] = []

async function closeAll(): Promise<void> {
  for (const a of launched) {
    try {
      // Harness gap: AppHandle.close() crashes on an already-exited process.
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

function persistedSettings(handle: AppHandle): Record<string, unknown> | null {
  const raw = handle.readPersisted('settings.json')
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
}

/** Shell-bridge call via string expression (no ambient Window typing needed). */
async function relayBridge<T>(app: AppHandle, expr: string): Promise<T> {
  return app.page.evaluate(
    `(window.vikingRelay && window.vikingRelay.${expr}) || Promise.reject(new Error('shell bridge unavailable'))`
  ) as Promise<T>
}

/**
 * Clicks a modal action button. The server SettingsPanel modal content can
 * overflow its fixed, non-scrollable overlay (product layout defect — see
 * report; GlobalSettingsModal has max-h/overflow-y-auto, this Modal does
 * not), leaving bottom buttons outside the viewport where Playwright's
 * pointer simulation refuses to click. Fall back to a real DOM click event
 * (same React handler) and capture screenshot evidence of the overflow.
 */
async function clickModalAction(app: AppHandle, locator: Locator): Promise<void> {
  try {
    await locator.click({ timeout: 5_000 })
  } catch {
    await app.screenshot('modal-overflow-defect')
    await locator.dispatchEvent('click')
  }
}

/* Structural subsets of src/shared/ipc.ts (test-typed). */
interface UpdateStateLike {
  phase: string
  currentVersion: string
  disabled: boolean
  channel?: 'stable' | 'beta'
}
interface DdStateLike {
  settings: { autoAccept: boolean; qbitUrl: string; qbitKeySet: boolean; downloadDir: string | null }
}

async function openGlobalSettings(app: AppHandle): Promise<void> {
  await app.page.getByTestId('global-settings-button').click()
  await expect(app.page.getByTestId('global-settings-modal')).toBeVisible()
}

/** Server-mode fixture that lands on the Dashboard (working folder set). */
async function launchServerDashboard(
  testId: string,
  label: string
): Promise<{ app: AppHandle; dataDir: string }> {
  const dataDir = makeTempUserData(`${label}-data`)
  const app = await launchApp({ testId, label, settings: { mode: 'server', dataDir } })
  launched.push(app)
  // Dashboard gate: workingFolderPath non-null ⇒ Dashboard mounts.
  await expect(app.page.getByTestId('open-settings')).toBeVisible({ timeout: 20_000 })
  return { app, dataDir }
}

async function openServerSettings(app: AppHandle): Promise<void> {
  await app.page.getByTestId('open-settings').click()
  await expect(app.page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
}

/* ------------------------------------------------------------------ */
/* UI-001..004 — global settings modal open/close                      */

test('UI-001: ⚙ opens the global settings modal with updates section', async () => {
  const app = await launchApp({ testId: 'UI-001', label: 'shell' })
  launched.push(app)
  await openGlobalSettings(app)
  await expect(app.page.getByTestId('global-updates-section')).toBeVisible()
  await expect(app.page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
})

test('UI-002: modal closes via the ✕ button', async () => {
  const app = await launchApp({ testId: 'UI-002', label: 'shell' })
  launched.push(app)
  await openGlobalSettings(app)
  await app.page.getByLabel('Close settings').click()
  await expect(app.page.getByTestId('global-settings-modal')).toBeHidden()
})

test('UI-003: modal closes via backdrop click', async () => {
  const app = await launchApp({ testId: 'UI-003', label: 'shell' })
  launched.push(app)
  await openGlobalSettings(app)
  // Click the overlay itself, outside the centered panel.
  await app.page.getByTestId('global-settings-modal').click({ position: { x: 10, y: 10 } })
  await expect(app.page.getByTestId('global-settings-modal')).toBeHidden()
})

test('UI-004: modal closes via Escape', async () => {
  const app = await launchApp({ testId: 'UI-004', label: 'shell' })
  launched.push(app)
  await openGlobalSettings(app)
  await app.page.keyboard.press('Escape')
  await expect(app.page.getByTestId('global-settings-modal')).toBeHidden()
})

/* ------------------------------------------------------------------ */
/* UI-005..007 — updates section (dev build)                           */

test('UI-005: dev build reports updates disabled', async () => {
  const app = await launchApp({ testId: 'UI-005', label: 'updates' })
  launched.push(app)
  const upd = await relayBridge<UpdateStateLike>(app, 'getUpdateState()')
  expect(upd.disabled).toBe(true)
  await openGlobalSettings(app)
  await expect(app.page.getByTestId('global-update-status')).toContainText(
    'disabled in development builds'
  )
})

test('UI-006: check-for-updates resolves without crash in dev build', async () => {
  const app = await launchApp({ testId: 'UI-006', label: 'updates' })
  launched.push(app)
  await openGlobalSettings(app)
  const errorsBefore = app.pageErrorCount()
  await app.page.getByTestId('global-check-updates').click()
  // Dev build short-circuits (phase stays idle); packaged builds may land on
  // error/not-available. Accept any terminal phase — the contract is "resolves
  // and does not crash".
  await app.waitFor('check-for-updates resolved (button re-enabled)', async () =>
    app.page.getByTestId('global-check-updates').isEnabled()
  )
  const upd = await relayBridge<UpdateStateLike>(app, 'getUpdateState()')
  expect(['idle', 'error', 'not-available']).toContain(upd.phase)
  expect(app.pageErrorCount()).toBe(errorsBefore)
})

test('UI-007: no install offer while nothing was downloaded; version reported truthfully', async () => {
  const app = await launchApp({ testId: 'UI-007', label: 'updates' })
  launched.push(app)
  const state = await app.getState()
  const upd = await relayBridge<UpdateStateLike>(app, 'getUpdateState()')
  expect(upd.currentVersion).toBe(state.versions.app)
  await openGlobalSettings(app)
  await expect(app.page.getByTestId('global-install-update')).toHaveCount(0)
  await expect(app.page.getByTestId('global-update-status')).toContainText(upd.currentVersion)
})

/* ------------------------------------------------------------------ */
/* UI-008..010 — startup toggles + logs folder                         */

test('UI-008: start-with-windows toggle persists to settings.json', async () => {
  const app = await launchApp({ testId: 'UI-008', label: 'startup' })
  launched.push(app)
  await openGlobalSettings(app)
  await expect(app.page.getByTestId('startup-section')).toBeVisible()

  const toggle = app.page.getByTestId('start-with-windows')
  await toggle.check()
  await app.waitFor('settings.json startWithWindows=true', async () => {
    return persistedSettings(app)?.['startWithWindows'] === true
  })
  // Revert so we do not leave a real Windows login item behind.
  await toggle.uncheck()
  await app.waitFor('settings.json startWithWindows=false (reverted)', async () => {
    return persistedSettings(app)?.['startWithWindows'] === false
  })
})

test('UI-009: minimize-to-tray off persists AND close then really quits', async () => {
  const app = await launchApp({ testId: 'UI-009', label: 'tray-off' })
  launched.push(app)
  await openGlobalSettings(app)
  await expect(app.page.getByTestId('startup-section')).toBeVisible()

  await app.page.getByTestId('minimize-to-tray').uncheck()
  await app.waitFor('settings.json minimizeToTrayOnClose=false', async () => {
    return persistedSettings(app)?.['minimizeToTrayOnClose'] === false
  })

  // Close behavior follows the setting: X now really exits (window-all-closed → quit).
  const proc = app.app.process()
  const win = await app.app.browserWindow(app.page)
  await win.evaluate((w) => (w as { close(): void }).close())
  const deadline = Date.now() + 20_000
  let exited = false
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.killed) {
      exited = true
      break
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  expect(exited, 'process must exit when minimize-to-tray is disabled').toBe(true)
})

test('UI-010: open logs folder resolves true; logs dir exists on disk; button wired', async () => {
  const app = await launchApp({ testId: 'UI-010', label: 'logs' })
  launched.push(app)

  const resolved = await relayBridge(app, 'openLogsFolder()')
  expect(resolved).toBe(true)
  expect(existsSync(join(app.userDataDir, 'logs'))).toBe(true)

  // The real button is wired to the same IPC and produces no page errors.
  await openGlobalSettings(app)
  const errorsBefore = app.pageErrorCount()
  await app.page.getByTestId('open-logs-folder').click()
  // Round-trip the bridge once so any async pageerror from the click's IPC
  // surfaces before the assertion (no arbitrary sleeps).
  await relayBridge(app, 'getState()')
  expect(app.pageErrorCount()).toBe(errorsBefore)
})

/* ------------------------------------------------------------------ */
/* UI-011..014 — client receiver (direct downloads) settings           */

async function launchClientWithReceiver(testId: string, label: string): Promise<AppHandle> {
  const app = await launchApp({ testId, label, settings: { mode: 'client' } })
  launched.push(app)
  await openGlobalSettings(app)
  await expect(app.page.getByTestId('direct-downloads-section')).toBeVisible()
  return app
}

test('UI-011: auto-accept toggle saves and persists', async () => {
  const app = await launchClientWithReceiver('UI-011', 'receiver')
  // Controlled checkbox: state flips only after the IPC round trip, so use
  // click() (no immediate state verification) and wait on persistence.
  await app.page.getByTestId('dd-auto-accept').click()
  await app.waitFor('directAutoAccept=true persisted', async () => {
    return persistedSettings(app)?.['directAutoAccept'] === true
  })
  const dd = await relayBridge<DdStateLike>(app, 'getDirectDownloadsState()')
  expect(dd.settings.autoAccept).toBe(true)
})

test('UI-012: qBittorrent WebUI URL saves and persists', async () => {
  const app = await launchClientWithReceiver('UI-012', 'receiver')
  const url = 'http://127.0.0.1:24999'
  await app.page.getByTestId('dd-qbit-url').fill(url)
  await app.page.getByTestId('dd-save').click()
  await app.waitFor('clientQbitUrl persisted', async () => {
    return persistedSettings(app)?.['clientQbitUrl'] === url
  })
  const dd = await relayBridge<DdStateLike>(app, 'getDirectDownloadsState()')
  expect(dd.settings.qbitUrl).toBe(url)
})

test('UI-013: qBittorrent API key save flips qbitKeySet', async () => {
  const app = await launchClientWithReceiver('UI-013', 'receiver')
  const before = await relayBridge<DdStateLike>(app, 'getDirectDownloadsState()')
  expect(before.settings.qbitKeySet).toBe(false)

  await app.page.getByTestId('dd-qbit-key').fill('e2e-receiver-key')
  await app.page.getByTestId('dd-save').click()

  await app.waitFor('qbitKeySet flipped true', async () => {
    const dd = await relayBridge<DdStateLike>(app, 'getDirectDownloadsState()')
    return dd.settings.qbitKeySet === true
  })
  // The write-only mask flips to the saved placeholder.
  await expect(app.page.getByTestId('dd-qbit-key')).toHaveAttribute('placeholder', /saved/i)
})

test('UI-014: download dir saves and persists', async () => {
  const app = await launchClientWithReceiver('UI-014', 'receiver')
  const dir = makeTempUserData('ui14-downloads')
  await app.page.getByTestId('dd-download-dir').fill(dir)
  await app.page.getByTestId('dd-save').click()
  await app.waitFor('clientDownloadDir persisted', async () => {
    return persistedSettings(app)?.['clientDownloadDir'] === dir
  })
  const dd = await relayBridge<DdStateLike>(app, 'getDirectDownloadsState()')
  expect(dd.settings.downloadDir).toBe(dir)
  expect(existsSync(dir)).toBe(true)
})

/* ------------------------------------------------------------------ */
/* SET-001..012 — server SettingsPanel                                 */

test('SET-001: panel opens pre-populated from current settings', async () => {
  const { app, dataDir } = await launchServerDashboard('SET-001', 'set')
  await openServerSettings(app)
  await expect(app.page.getByLabel('Working folder')).toHaveValue(dataDir)
  await expect(app.page.getByLabel('Relay port')).toHaveValue('47821')
  await expect(app.page.getByLabel('qBittorrent WebUI URL')).toHaveValue('http://127.0.0.1:8080')
})

test('SET-002: working folder change persists via updateSettings bridge', async () => {
  const { app } = await launchServerDashboard('SET-002', 'set')
  const newDir = makeTempUserData('set2-folder')
  await openServerSettings(app)
  await app.page.getByLabel('Working folder').fill(newDir)
  await clickModalAction(app, app.page.getByTestId('settings-save'))
  await app.waitFor('dataDir persisted', async () => {
    return persistedSettings(app)?.['dataDir'] === newDir
  })
  const view = await app.serverBridge<Record<string, unknown>>('getSettings()')
  expect(view['workingFolderPath']).toBe(newDir)
})

test('SET-003: relay port change persists', async () => {
  const { app } = await launchServerDashboard('SET-003', 'set')
  await openServerSettings(app)
  await app.page.getByLabel('Relay port').fill('47999')
  await clickModalAction(app, app.page.getByTestId('settings-save'))
  await app.waitFor('serverPort persisted', async () => {
    return persistedSettings(app)?.['serverPort'] === 47999
  })
  const view = await app.serverBridge<Record<string, unknown>>('getSettings()')
  expect(view['relayPort']).toBe(47999)
})

test('SET-004: qBittorrent WebUI URL change persists (normalized)', async () => {
  const { app } = await launchServerDashboard('SET-004', 'set')
  await openServerSettings(app)
  await app.page.getByLabel('qBittorrent WebUI URL').fill('http://127.0.0.1:31337')
  await clickModalAction(app, app.page.getByTestId('settings-save'))
  await app.waitFor('qbittorrentBaseUrl persisted', async () => {
    return persistedSettings(app)?.['qbittorrentBaseUrl'] === 'http://127.0.0.1:31337'
  })
  const view = await app.serverBridge<Record<string, unknown>>('getSettings()')
  expect(view['qbitWebUiUrl']).toBe('http://127.0.0.1:31337')
})

test('SET-005: prevent-sleep toggle persists', async () => {
  const { app } = await launchServerDashboard('SET-005', 'set')
  await openServerSettings(app)
  const toggle = app.page.getByRole('switch', { name: 'Prevent sleep during transfers' })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await app.waitFor('preventSleepDuringTransfers=false persisted', async () => {
    return persistedSettings(app)?.['preventSleepDuringTransfers'] === false
  })
})

test('SET-006: cleanup toggles persist all three flags', async () => {
  const { app } = await launchServerDashboard('SET-006', 'set')
  await openServerSettings(app)
  // B-class note: SettingsPanel passes data-testid to <Toggle>, but Toggle
  // does not spread rest props — those testids never reach the DOM. The
  // accessible name (role=switch + aria-label) is the stable locator.
  await app.page.getByRole('switch', { name: 'Delete torrent from qBittorrent' }).click()
  await app.page.getByRole('switch', { name: 'Delete downloaded files' }).click()
  await app.page.getByRole('switch', { name: 'Delete temporary ZIP' }).click()
  await app.waitFor('cleanup flags persisted false', async () => {
    const s = persistedSettings(app)
    return (
      s?.['cleanupDeleteTorrent'] === false &&
      s?.['cleanupDeleteFiles'] === false &&
      s?.['cleanupDeleteZip'] === false
    )
  })
})

test('SET-007: start-with-windows toggle persists on and off', async () => {
  const { app } = await launchServerDashboard('SET-007', 'set')
  await openServerSettings(app)
  const toggle = app.page.getByRole('switch', { name: 'Start server with Windows' })
  await toggle.click()
  await app.waitFor('startWithWindows=true persisted', async () => {
    return persistedSettings(app)?.['startWithWindows'] === true
  })
  // Revert so no real Windows login item is left registered.
  await toggle.click()
  await app.waitFor('startWithWindows=false reverted', async () => {
    return persistedSettings(app)?.['startWithWindows'] === false
  })
})

test('SET-008: qbit key save flips qbitApiKeySet with Saved ✓ indicator', async () => {
  const { app } = await launchServerDashboard('SET-008', 'set')
  const before = await app.serverBridge<Record<string, unknown>>('getSettings()')
  expect(before['qbitApiKeySet']).toBe(false)

  await openServerSettings(app)
  await app.page.getByLabel('qBittorrent API key').fill('e2e-set-key')
  await app.page.getByTestId('save-qbit-key').click()

  await expect(app.page.getByTestId('qbit-key-saved-indicator')).toContainText('Saved ✓')
  await app.waitFor('qbitApiKeySet=true via bridge', async () => {
    const view = await app.serverBridge<Record<string, unknown>>('getSettings()')
    return view['qbitApiKeySet'] === true
  })
})

test('SET-009: edited fields survive restart (persisted bytes re-seeded)', async () => {
  const first = await launchServerDashboard('SET-009', 'set-a')
  const app = first.app
  await openServerSettings(app)
  await app.page.getByLabel('Relay port').fill('48042')
  await app.page.getByLabel('qBittorrent WebUI URL').fill('http://127.0.0.1:31415')
  await clickModalAction(app, app.page.getByTestId('settings-save'))
  await app.waitFor('edits persisted', async () => {
    const s = persistedSettings(app)
    return s?.['serverPort'] === 48042 && s?.['qbittorrentBaseUrl'] === 'http://127.0.0.1:31415'
  })
  const bytes = app.readPersisted('settings.json')
  expect(bytes).toBeTruthy()
  await app.close()

  const restarted = await launchApp({
    testId: 'SET-009',
    label: 'set-b',
    settings: JSON.parse(bytes!) as Record<string, never>
  })
  launched.push(restarted)
  await expect(restarted.page.getByTestId('open-settings')).toBeVisible({ timeout: 20_000 })
  const view = await restarted.serverBridge<Record<string, unknown>>('getSettings()')
  expect(view['relayPort']).toBe(48042)
  expect(view['qbitWebUiUrl']).toBe('http://127.0.0.1:31415')
})

test('SET-010: reset profile cancel keeps the profile intact', async () => {
  const { app, dataDir } = await launchServerDashboard('SET-010', 'set')
  await openServerSettings(app)
  // Playwright auto-DISMISSES window.confirm when no handler is registered:
  // this drives the real cancel path (confirm() === false).
  await clickModalAction(app, app.page.getByTestId('reset-profile'))
  await app.waitFor('no reload happened (dashboard still mounted)', async () => {
    return (await app.getState()).mode === 'server'
  })
  const s = persistedSettings(app)
  expect(s?.['mode']).toBe('server')
  expect(s?.['dataDir']).toBe(dataDir)
  await expect(app.page.getByTestId('open-settings')).toBeVisible()
})

test('SET-011: reset profile confirm wipes profile and returns to chooser', async () => {
  const { app } = await launchServerDashboard('SET-011', 'set')
  await openServerSettings(app)
  // Drive the REAL confirmation dialog: accept window.confirm.
  app.page.once('dialog', (dialog) => void dialog.accept())
  await clickModalAction(app, app.page.getByTestId('reset-profile'))

  // resetProfile wipes settings then location.reload() ⇒ ModeChooser.
  await app.waitFor('back on mode chooser after reset', async () => {
    return app.page.getByText('Welcome to Viking Relay').isVisible().catch(() => false)
  })
  await app.waitFor('profile wiped in settings.json', async () => {
    const s = persistedSettings(app)
    return s?.['mode'] === null && s?.['dataDir'] === null
  })
  expect((await app.getState()).mode).toBeNull()
})

test('SET-012: openQBittorrentWebUi resolves without page errors', async () => {
  const { app } = await launchServerDashboard('SET-012', 'set')
  const errorsBefore = app.pageErrorCount()
  // Resolves (void); shell.openExternal fires against the configured URL.
  const result = await app.serverBridge<unknown>('openQBittorrentWebUi()')
  expect(result).toBeUndefined()
  expect(app.pageErrorCount()).toBe(errorsBefore)
})

/* ------------------------------------------------------------------ */
/* SET-013 — update channel selector (global settings)                 */

test('SET-013: channel selector persists beta then stable; state reflects channel', async () => {
  const app = await launchApp({ testId: 'SET-013', label: 'channel' })
  launched.push(app)
  await openGlobalSettings(app)
  await expect(app.page.getByTestId('update-channel-selector')).toBeVisible()

  // Dev build: updater is disabled, but the channel still round-trips
  // through settings persistence and getUpdateState().channel.
  const initial = await relayBridge<UpdateStateLike>(app, 'getUpdateState()')
  expect(initial.channel).toBe('stable')
  await expect(app.page.getByTestId('update-channel-stable')).toHaveAttribute(
    'aria-checked',
    'true'
  )

  await app.page.getByTestId('update-channel-beta').click()
  await app.waitFor('updateChannel=beta persisted', async () => {
    return persistedSettings(app)?.['updateChannel'] === 'beta'
  })
  const onBeta = await relayBridge<UpdateStateLike>(app, 'getUpdateState()')
  expect(onBeta.channel).toBe('beta')
  await expect(app.page.getByTestId('update-channel-beta')).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(app.page.getByTestId('global-update-status')).toContainText('beta channel')

  // Switch back to Stable.
  await app.page.getByTestId('update-channel-stable').click()
  await app.waitFor('updateChannel=stable persisted back', async () => {
    return persistedSettings(app)?.['updateChannel'] === 'stable'
  })
  const onStable = await relayBridge<UpdateStateLike>(app, 'getUpdateState()')
  expect(onStable.channel).toBe('stable')
  await expect(app.page.getByTestId('global-update-status')).toContainText('stable channel')
})
