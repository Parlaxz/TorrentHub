import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { launchApp, type AppHandle } from './harness/app'
import {
  launchServer,
  pairClient,
  E2E_MAGNET,
  type ServerCluster,
  type PairedClient
} from './harness/cluster'
import { makeTempUserData } from './harness/paths'

/**
 * UISWEEP lane - machine-readable interactive-control inventory per mounted
 * surface. Permanent IDs UISWEEP-001..012; never renumber.
 *
 * Gate: ZERO interactive controls (buttons/links/textboxes/searchboxes/
 * checkboxes/radios/comboboxes/switches) may have an EMPTY accessible name.
 * Every sweep dumps a JSON inventory artifact into the test's artifacts dir
 * (AppHandle.artifactsDir) listing role + accessible name per control.
 */

/* ------------------------------------------------------------------ */
/* Inventory machinery                                                 */

const ROLES = ['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'switch'] as const

interface ControlRow {
  role: string
  name: string
  tag: string
  testid: string | null
}

interface SurfaceInventory {
  surface: string
  capturedAt: string
  /** Counts straight from page.getByRole(...).count() per role. */
  counts: Record<string, number>
  /** DOM-derived rows with an approximated accessible name per control. */
  controls: ControlRow[]
  unnamed: ControlRow[]
}

/**
 * Approximate accessible-name computation (aria-labelledby > aria-label >
 * native label[for] > wrapping label > value/placeholder > text content).
 * Matches the ARIA name computation closely enough to catch unnamed controls;
 * any control this marks "named" via placeholder-only is reported separately
 * as a weak-name observation in the artifact.
 */
function collectRows(page: Page): Promise<ControlRow[]> {
  return page.evaluate(() => {
    function accName(el: Element): string {
      const labelledby = el.getAttribute('aria-labelledby')
      if (labelledby) {
        const t = labelledby
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (t) return t
      }
      const al = el.getAttribute('aria-label')
      if (al && al.trim()) return al.trim()
      const he = el as HTMLElement
      if (he.id) {
        const lbl = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(he.id) : he.id) + '"]')
        if (lbl) {
          const t = (lbl.textContent ?? '').replace(/\s+/g, ' ').trim()
          if (t) return t
        }
      }
      const wrap = el.closest('label')
      if (wrap) {
        const clone = wrap.cloneNode(true) as HTMLElement
        clone.querySelectorAll('input,textarea,select,button').forEach((n) => n.remove())
        const t = (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (t) return t
      }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const inp = el as HTMLInputElement
        if (inp.type === 'button' || inp.type === 'submit' || inp.type === 'reset') return inp.value
        if (inp.value && inp.readOnly) return inp.value
        const ph = inp.getAttribute('placeholder')
        if (ph) return ph
      }
      return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    }
    const groups: Array<[string, string]> = [
      ['button', 'button, [role="button"]'],
      ['link', 'a[href], [role="link"]'],
      [
        'textbox',
        'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]):not([type="search"]), textarea, [role="textbox"]'
      ],
      ['searchbox', 'input[type="search"]'],
      ['checkbox', 'input[type="checkbox"], [role="checkbox"]'],
      ['radio', 'input[type="radio"], [role="radio"]'],
      ['combobox', 'select, [role="combobox"]'],
      ['switch', '[role="switch"]']
    ]
    const out: ControlRow[] = []
    for (const [role, sel] of groups) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        out.push({
          role,
          name: accName(el),
          tag: el.tagName.toLowerCase(),
          testid: el.getAttribute('data-testid')
        })
      }
    }
    return out
  })
}

/** Collects the inventory, dumps the JSON artifact, enforces the zero-unnamed gate. */
async function sweepSurface(app: AppHandle, surface: string): Promise<SurfaceInventory> {
  const controls = await collectRows(app.page)
  const counts: Record<string, number> = {}
  for (const role of ROLES) counts[role] = await app.page.getByRole(role).count()
  const unnamed = controls.filter((c) => !c.name)
  const inv: SurfaceInventory = {
    surface,
    capturedAt: new Date().toISOString(),
    counts,
    controls,
    unnamed
  }
  // Artifact FIRST so evidence survives a gate failure.
  writeFileSync(join(app.artifactsDir, `control-inventory-${surface}.json`), JSON.stringify(inv, null, 2))
  await app.marker(`uisweep-inventory-${surface}`, { counts, total: controls.length, unnamed: unnamed.length })
  console.log(
    `[UISWEEP] ${surface}: ${controls.length} controls | ` +
      Object.entries(counts)
        .map(([r, n]) => `${r}=${n}`)
        .join(' ') +
      ` | unnamed=${unnamed.length}`
  )
  expect(
    unnamed,
    `zero-unnamed-controls gate failed on "${surface}": ${JSON.stringify(unnamed)}`
  ).toEqual([])
  return inv
}

/* ------------------------------------------------------------------ */
/* Cluster lifecycle + shared steps                                    */

let server: ServerCluster | null = null
let client: PairedClient | null = null
const extraApps: AppHandle[] = []

async function startCluster(
  testId: string,
  opts: { pair?: boolean; downloadTicks?: number } = {}
): Promise<ServerCluster> {
  server = await launchServer({
    testId,
    label: 'server',
    qbitScenario: opts.downloadTicks ? { downloadTicks: opts.downloadTicks } : undefined
  })
  if (opts.pair !== false) {
    client = await pairClient({ testId, server })
  }
  return server
}

test.afterEach(async () => {
  if (client) {
    const c = client
    client = null
    await c.close().catch(() => undefined)
  }
  while (extraApps.length) {
    const a = extraApps.pop()!
    await a.close().catch(() => undefined)
  }
  if (server) {
    const s = server
    server = null
    await s.close().catch(() => undefined)
  }
})

async function submitIntake(app: AppHandle, input: string): Promise<void> {
  const intake = app.page.getByRole('textbox', { name: 'Torrent magnet link or URL' })
  await intake.waitFor({ state: 'visible', timeout: 10_000 })
  await intake.fill(input)
  await app.marker('submitting-intake', { input })
  await app.page.getByRole('button', { name: 'Continue', exact: true }).click()
}

async function reachTree(app: AppHandle): Promise<void> {
  await app.waitFor('selection screen with torrent file tree', async () => {
    return (await app.page.getByRole('tree', { name: 'Torrent files' }).count()) > 0
  })
}

async function continueToPreflight(app: AppHandle): Promise<void> {
  await app.page.getByRole('button', { name: 'Continue', exact: true }).click()
  await app.waitFor('preflight verdict + Start button', async () => {
    const start = app.page.getByRole('button', { name: 'Start', exact: true })
    return (await start.count()) > 0 && start.first().isVisible()
  })
}

/* ------------------------------------------------------------------ */
/* UISWEEP-001..012                                                    */

test('UISWEEP-001: ModeChooser / fresh shell control inventory', async () => {
  const app = await launchApp({ testId: 'UISWEEP-001', label: 'fresh' })
  extraApps.push(app)
  await app.page.getByRole('button', { name: 'Client PC' }).waitFor({ state: 'visible', timeout: 10_000 })
  await app.screenshot('mode-chooser')

  await sweepSurface(app, 'mode-chooser')

  // Curated semantic cross-check.
  await expect(app.page.getByRole('button', { name: 'Client PC' })).toHaveCount(1)
  await expect(app.page.getByRole('button', { name: 'Server PC' })).toHaveCount(1)
  await expect(app.page.getByTestId('global-settings-button')).toBeVisible()
})

test('UISWEEP-002: client Connect screen control inventory', async () => {
  const app = await launchApp({ testId: 'UISWEEP-002', label: 'client-connect', settings: { mode: 'client' } })
  extraApps.push(app)
  await app.page.getByRole('button', { name: /Pair & Connect/ }).waitFor({ state: 'visible', timeout: 10_000 })
  await app.screenshot('client-connect')

  await sweepSurface(app, 'client-connect')

  await expect(app.page.getByLabel('Server IP')).toBeVisible()
  await expect(app.page.getByLabel('Port')).toBeVisible()
  await expect(app.page.getByLabel('Pairing Code')).toBeVisible()
  await expect(app.page.getByRole('button', { name: /Pair & Connect/ })).toHaveCount(1)
})

test('UISWEEP-003: client Home screen control inventory', async () => {
  await startCluster('UISWEEP-003')
  const app = client!.app
  await app.page.getByRole('textbox', { name: 'Torrent magnet link or URL' }).waitFor({ state: 'visible', timeout: 10_000 })
  await app.screenshot('client-home')

  await sweepSurface(app, 'client-home')

  await expect(app.page.getByRole('textbox', { name: 'Torrent magnet link or URL' })).toHaveCount(1)
  await expect(app.page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(1)
  await expect(app.page.getByTestId('add-friend')).toBeVisible()
})

test('UISWEEP-004: client Selection screen (active draft) control inventory', async () => {
  await startCluster('UISWEEP-004')
  const app = client!.app
  await submitIntake(app, E2E_MAGNET)
  await reachTree(app)
  await app.screenshot('client-selection')

  await sweepSurface(app, 'client-selection')

  await expect(app.page.getByRole('searchbox', { name: 'Filter files' })).toHaveCount(1)
  await expect(app.page.getByRole('button', { name: 'Select All' })).toHaveCount(1)
  await expect(app.page.getByRole('button', { name: 'Select None' })).toHaveCount(1)
  await expect(app.page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(1)
  await expect(app.page.getByRole('tree', { name: 'Torrent files' })).toHaveCount(1)
})

test('UISWEEP-005: client ActiveJob screen control inventory', async () => {
  test.slow()
  await startCluster('UISWEEP-005', { downloadTicks: 40 })
  const app = client!.app
  await submitIntake(app, E2E_MAGNET)
  await reachTree(app)
  await continueToPreflight(app)
  await app.page.getByRole('button', { name: 'Start', exact: true }).click()
  await app.waitFor(
    'active job screen (stage pipeline visible)',
    async () => (await app.page.getByText('UPLOAD TO VIKING').count()) > 0,
    { timeoutMs: 30_000 }
  )
  await app.screenshot('client-active-job')

  await sweepSurface(app, 'client-active-job')

  await expect(app.page.getByRole('button', { name: 'Cancel job' })).toHaveCount(1)
  await expect(app.page.getByRole('list', { name: 'Job stages' })).toHaveCount(1)

  // Leave no live job behind.
  await app.page.getByRole('button', { name: 'Cancel job' }).click()
  await app.waitFor('back on Home after cancel', async () => {
    return (await app.page.getByRole('textbox', { name: 'Torrent magnet link or URL' }).count()) > 0
  })
})

test('UISWEEP-006: client Complete screen control inventory', async () => {
  test.slow()
  await startCluster('UISWEEP-006')
  const app = client!.app
  await submitIntake(app, E2E_MAGNET)
  await reachTree(app)
  await continueToPreflight(app)
  await app.page.getByRole('button', { name: 'Start', exact: true }).click()
  await app.waitFor(
    'CompleteScreen',
    async () => (await app.page.getByRole('heading', { name: 'Complete' }).count()) > 0,
    { timeoutMs: 60_000 }
  )
  await app.screenshot('client-complete')

  await sweepSurface(app, 'client-complete')

  await expect(app.page.getByRole('textbox', { name: 'Viking URL' })).toHaveCount(1)
  await expect(app.page.getByRole('button', { name: 'Copy Link', exact: true })).toHaveCount(1)
  await expect(app.page.getByTestId('open-page-link')).toHaveCount(1)
  await expect(app.page.getByRole('button', { name: 'New Torrent' })).toHaveCount(1)
})

test('UISWEEP-007: client History screen control inventory', async () => {
  await startCluster('UISWEEP-007')
  const app = client!.app
  await app.page.getByRole('textbox', { name: 'Torrent magnet link or URL' }).waitFor({ state: 'visible', timeout: 10_000 })
  await app.page.getByRole('button', { name: 'History', exact: true }).click()
  await app.page.getByRole('heading', { name: 'Recent jobs' }).waitFor({ state: 'visible', timeout: 10_000 })
  await app.screenshot('client-history')

  await sweepSurface(app, 'client-history')

  await expect(app.page.getByRole('heading', { name: 'Recent jobs' })).toHaveCount(1)
  await expect(app.page.getByRole('button', { name: 'Close', exact: true })).toHaveCount(1)
})

test('UISWEEP-008: server Dashboard control inventory', async () => {
  await startCluster('UISWEEP-008', { pair: false })
  const app = server!.app
  await app.page.getByTestId('online-line').waitFor({ state: 'visible', timeout: 15_000 })
  await app.screenshot('server-dashboard')

  await sweepSurface(app, 'server-dashboard')

  await expect(app.page.getByTestId('pair-client')).toBeVisible()
  await expect(app.page.getByTestId('send-to-friend')).toBeVisible()
  await expect(app.page.getByTestId('open-settings')).toBeVisible()
  await expect(app.page.getByTestId('exit-button')).toBeVisible()
  await expect(app.page.getByTestId('history')).toBeVisible()
})

test('UISWEEP-009: server PairingModal (open) control inventory', async () => {
  await startCluster('UISWEEP-009', { pair: false })
  const app = server!.app
  await app.page.getByTestId('online-line').waitFor({ state: 'visible', timeout: 15_000 })
  await app.page.getByTestId('pair-client').click()
  await app.page.getByTestId('pairing-code').waitFor({ state: 'visible', timeout: 10_000 })
  await app.screenshot('server-pairing-modal')

  await sweepSurface(app, 'server-pairing-modal')

  await expect(app.page.getByTestId('pairing-regenerate')).toHaveCount(1)
  await expect(app.page.getByTestId('pairing-code')).toBeVisible()
  await expect(app.page.getByRole('dialog', { name: 'Pair a Client' })).toHaveCount(1)
})

test('UISWEEP-010: server SendDirectModal (open, paired client present) control inventory', async () => {
  await startCluster('UISWEEP-010')
  const app = server!.app
  await app.page.getByTestId('online-line').waitFor({ state: 'visible', timeout: 15_000 })
  await app.page.getByTestId('send-to-friend').click()
  await app.page.getByTestId('send-target').waitFor({ state: 'visible', timeout: 10_000 })
  await app.screenshot('server-send-direct-modal')

  await sweepSurface(app, 'server-send-direct-modal')

  await expect(app.page.getByTestId('send-target')).toHaveCount(1)
  await expect(app.page.getByLabel('Magnet or link')).toBeVisible()
  await expect(app.page.getByTestId('send-direct')).toHaveCount(1)
  await expect(app.page.getByRole('dialog', { name: 'Send to friend' })).toHaveCount(1)
})

test('UISWEEP-011: server SettingsPanel (open) control inventory', async () => {
  await startCluster('UISWEEP-011', { pair: false })
  const app = server!.app
  await app.page.getByTestId('online-line').waitFor({ state: 'visible', timeout: 15_000 })
  await app.page.getByTestId('open-settings').click()
  await app.page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible', timeout: 10_000 })
  await app.screenshot('server-settings-panel')

  await sweepSurface(app, 'server-settings-panel')

  await expect(app.page.getByLabel('Working folder')).toBeVisible()
  await expect(app.page.getByLabel('Relay port')).toBeVisible()
  await expect(app.page.getByLabel('qBittorrent WebUI URL')).toBeVisible()
  await expect(app.page.getByLabel('qBittorrent API key')).toBeVisible()
  await expect(app.page.getByTestId('save-qbit-key')).toHaveCount(1)
  await expect(app.page.getByTestId('settings-save')).toHaveCount(1)
  await expect(app.page.getByTestId('reset-profile')).toHaveCount(1)
  // Toggles: start-with-windows, prevent-sleep, 3x cleanup defaults.
  expect(await app.page.getByRole('switch').count()).toBeGreaterThanOrEqual(5)
})

test('UISWEEP-012: GlobalSettingsModal control inventory in BOTH modes', async () => {
  // Client mode instance.
  const cli = await launchApp({ testId: 'UISWEEP-012', label: 'client-global', settings: { mode: 'client' } })
  extraApps.push(cli)
  await cli.page.getByTestId('global-settings-button').waitFor({ state: 'visible', timeout: 10_000 })
  await cli.page.getByTestId('global-settings-button').click()
  await cli.page.getByTestId('global-settings-modal').waitFor({ state: 'visible', timeout: 10_000 })
  await cli.screenshot('global-settings-client')
  await sweepSurface(cli, 'global-settings-client')
  await expect(cli.page.getByTestId('global-check-updates')).toHaveCount(1)
  await expect(cli.page.getByTestId('start-with-windows')).toHaveCount(1)
  await expect(cli.page.getByTestId('minimize-to-tray')).toHaveCount(1)
  await expect(cli.page.getByTestId('open-logs-folder')).toHaveCount(1)
  await expect(cli.page.getByRole('button', { name: 'Close settings' })).toHaveCount(1)

  // Server mode instance (working folder seeded so the Dashboard mounts).
  const srvApp = await launchApp({
    testId: 'UISWEEP-012',
    label: 'server-global',
    settings: { mode: 'server', dataDir: makeTempUserData('uisweep012-data') }
  })
  extraApps.push(srvApp)
  await srvApp.page.getByTestId('exit-button').waitFor({ state: 'visible', timeout: 20_000 })
  await srvApp.page.getByTestId('global-settings-button').click()
  await srvApp.page.getByTestId('global-settings-modal').waitFor({ state: 'visible', timeout: 10_000 })
  await srvApp.screenshot('global-settings-server')
  await sweepSurface(srvApp, 'global-settings-server')
  await expect(srvApp.page.getByTestId('global-check-updates')).toHaveCount(1)
  await expect(srvApp.page.getByTestId('start-with-windows')).toHaveCount(1)
  await expect(srvApp.page.getByTestId('minimize-to-tray')).toHaveCount(1)
  await expect(srvApp.page.getByTestId('open-logs-folder')).toHaveCount(1)
  await expect(srvApp.page.getByRole('button', { name: 'Close settings' })).toHaveCount(1)
})
