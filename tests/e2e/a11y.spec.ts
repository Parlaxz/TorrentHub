import { test, expect } from '@playwright/test'
import type { Page } from 'playwright'
import { launchApp, type AppHandle } from './harness/app'
import {
  launchServer,
  pairClient,
  startRelay,
  E2E_MAGNET,
  type ServerCluster,
  type PairedClient
} from './harness/cluster'

/**
 * A11Y lane - keyboard, focus, disabled-state semantics, and live-region
 * checks. Permanent IDs A11Y-001..006; never renumber.
 *
 * waitFor discipline throughout; no arbitrary sleeps. Suspected product
 * defects are NOT fixed here (src/** is out of scope) - evidence is captured
 * in artifacts and classified in the run report.
 */

/* ------------------------------------------------------------------ */
/* Cluster lifecycle + shared steps                                    */

let server: ServerCluster | null = null
let client: PairedClient | null = null

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
/* Focus helpers                                                       */

interface FocusInfo {
  tag: string
  id: string
  label: string
  testid: string | null
  inDialog: boolean
}

function activeElementInfo(page: Page): Promise<FocusInfo> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) {
      return { tag: el ? 'body' : 'none', id: '', label: '', testid: null, inDialog: false }
    }
    let label = el.getAttribute('aria-label') ?? ''
    if (!label && el.id) {
      const lbl = document.querySelector('label[for="' + el.id + '"]')
      if (lbl) label = (lbl.textContent ?? '').replace(/\s+/g, ' ').trim()
    }
    if (!label) {
      const wrap = el.closest('label')
      if (wrap) {
        const clone = wrap.cloneNode(true) as HTMLElement
        clone.querySelectorAll('input,textarea,select,button').forEach((n) => n.remove())
        label = (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
      }
    }
    if (!label) label = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id,
      label,
      testid: el.getAttribute('data-testid'),
      inDialog: Boolean(el.closest('[role="dialog"]'))
    }
  })
}

const FOCUSABLE_SEL = 'button, input, [href], [tabindex]:not([tabindex="-1"])'

function focusInsideDialog(page: Page, which: 'first' | 'last'): Promise<boolean> {
  return page.evaluate(
    ([which, sel]) => {
      const dialog = document.querySelector('[role="dialog"]')
      if (!dialog) return false
      const focusables = Array.from(dialog.querySelectorAll(sel)) as HTMLElement[]
      if (focusables.length === 0) return false
      ;(which === 'first' ? focusables[0] : focusables[focusables.length - 1]).focus()
      return true
    },
    [which, FOCUSABLE_SEL] as const
  )
}

function activeElementIsAtDialogEdge(page: Page, edge: 'first' | 'last'): Promise<boolean> {
  return page.evaluate(
    ([edge, sel]) => {
      const dialog = document.querySelector('[role="dialog"]')
      if (!dialog) return false
      const focusables = Array.from(dialog.querySelectorAll(sel)) as HTMLElement[]
      if (focusables.length === 0) return false
      const target = edge === 'first' ? focusables[0] : focusables[focusables.length - 1]
      return document.activeElement === target
    },
    [edge, FOCUSABLE_SEL] as const
  )
}

/* ------------------------------------------------------------------ */
/* A11Y-001 - server Modal: Escape, focus trap                         */

test('A11Y-001: server SettingsPanel modal - Tab wraps both ways, Escape closes; initial focus lands inside dialog', async () => {
  const srv = await startCluster('A11Y-001', { pair: false })
  const app = srv.app
  const page = app.page
  await page.getByTestId('online-line').waitFor({ state: 'visible', timeout: 15_000 })

  // Open the Settings modal.
  await page.getByTestId('open-settings').click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })

  // Focus trap forward: Tab from LAST focusable wraps to FIRST.
  expect(await focusInsideDialog(page, 'last')).toBe(true)
  await page.keyboard.press('Tab')
  expect(
    await activeElementIsAtDialogEdge(page, 'first'),
    'Tab from last focusable must wrap to first focusable inside the dialog'
  ).toBe(true)

  // Focus trap backward: Shift+Tab from FIRST focusable wraps to LAST.
  expect(await focusInsideDialog(page, 'first')).toBe(true)
  await page.keyboard.press('Shift+Tab')
  expect(
    await activeElementIsAtDialogEdge(page, 'last'),
    'Shift+Tab from first focusable must wrap to last focusable inside the dialog'
  ).toBe(true)
  await app.screenshot('a11y-001-focus-trap')

  // Escape closes the modal.
  await page.keyboard.press('Escape')
  await app.waitFor('settings dialog closed by Escape', async () => {
    return (await page.getByRole('dialog').count()) === 0
  })

  // Reopen: initial focus must land INSIDE the dialog.
  await page.getByTestId('open-settings').click()
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  const info = await activeElementInfo(page)
  await app.screenshot('a11y-001-initial-focus')
  await app.marker('a11y-001-initial-focus', info)
  expect(
    info.inDialog,
    `initial focus must land inside [role=dialog] on open; landed on ${JSON.stringify(info)}`
  ).toBe(true)
})

/* ------------------------------------------------------------------ */
/* A11Y-002 - GlobalSettingsModal close paths (regression pin)         */

test('A11Y-002: GlobalSettingsModal closes via Escape, Close settings aria-label, and backdrop click', async () => {
  const app = await launchApp({ testId: 'A11Y-002', label: 'global-settings' })
  const page = app.page
  await page.getByTestId('global-settings-button').waitFor({ state: 'visible', timeout: 10_000 })

  // 1. Escape closes (recently fixed - regression pin).
  await page.getByTestId('global-settings-button').click()
  await page.getByTestId('global-settings-modal').waitFor({ state: 'visible', timeout: 10_000 })
  await page.keyboard.press('Escape')
  await app.waitFor('global settings closed by Escape', async () => {
    return (await page.getByTestId('global-settings-modal').count()) === 0
  })

  // 2. "Close settings" aria-label button closes.
  await page.getByTestId('global-settings-button').click()
  await page.getByTestId('global-settings-modal').waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByRole('button', { name: 'Close settings' }).click()
  await app.waitFor('global settings closed via Close settings button', async () => {
    return (await page.getByTestId('global-settings-modal').count()) === 0
  })

  // 3. Backdrop click closes (corner of the fixed inset-0 overlay).
  await page.getByTestId('global-settings-button').click()
  await page.getByTestId('global-settings-modal').waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByTestId('global-settings-modal').click({ position: { x: 5, y: 5 } })
  await app.waitFor('global settings closed via backdrop click', async () => {
    return (await page.getByTestId('global-settings-modal').count()) === 0
  })
  await app.screenshot('a11y-002-all-close-paths')
})

/* ------------------------------------------------------------------ */
/* A11Y-003 - connect form keyboard-only operation                     */

test('A11Y-003: connect form is keyboard-only operable - Tab order host/port/code/submit, Enter submits', async () => {
  const srv = await startCluster('A11Y-003', { pair: false })
  const generated = (await srv.app.serverBridge<Record<string, unknown>>(
    'generatePairingCode()'
  )) as Record<string, unknown>
  const code = extractCode(generated)
  expect(code, `no pairing code in response: ${JSON.stringify(generated)}`).toBeTruthy()

  const app = await launchApp({ testId: 'A11Y-003', label: 'client-kbd', settings: { mode: 'client' } })
  const page = app.page
  const submitBtn = page.getByRole('button', { name: /Pair & Connect/ })
  await submitBtn.waitFor({ state: 'visible', timeout: 10_000 })

  // autoFocus puts the caret on Server IP without any pointer/Tab input.
  let focus = await activeElementInfo(page)
  expect(focus.label, `expected initial focus on Server IP, got ${JSON.stringify(focus)}`).toContain('Server IP')

  // Keyboard-only fill in DOM order: host -> port -> code -> submit.
  await page.keyboard.type(srv.relayAddress)
  await page.keyboard.press('Tab')
  focus = await activeElementInfo(page)
  expect(focus.label, `after 1st Tab expected Port field, got ${JSON.stringify(focus)}`).toContain('Port')

  await page.keyboard.type(String(srv.relayPort))
  await page.keyboard.press('Tab')
  focus = await activeElementInfo(page)
  expect(focus.label, `after 2nd Tab expected Pairing Code field, got ${JSON.stringify(focus)}`).toContain('Pairing Code')

  await page.keyboard.type(code!)
  await page.keyboard.press('Tab')
  focus = await activeElementInfo(page)
  expect(
    focus.tag === 'button' && /Pair & Connect/.test(focus.label),
    `after 3rd Tab expected submit button focused, got ${JSON.stringify(focus)}`
  ).toBe(true)

  // Enter on the focused submit button submits the form.
  await page.keyboard.press('Enter')
  await app.waitFor(
    'keyboard-only pairing reaches connected Home',
    async () => {
      try {
        const conn = (await page.evaluate(
          () =>
            (
              window as unknown as {
                vikingClientBridge?: { getConnection(): { host?: string } | null }
              }
            ).vikingClientBridge?.getConnection() ?? null
        )) as { host?: string } | null
        return Boolean(conn && conn.host)
      } catch {
        return false
      }
    },
    { timeoutMs: 20_000 }
  )
  await app.screenshot('a11y-003-keyboard-paired')
})

function extractCode(payload: Record<string, unknown>): string | null {
  if (typeof payload['code'] === 'string') return payload['code']
  if (typeof payload['pairingCode'] === 'string') return payload['pairingCode'] as string
  const nested = payload['pairing']
  if (nested && typeof nested === 'object') return extractCode(nested as Record<string, unknown>)
  return null
}

/* ------------------------------------------------------------------ */
/* A11Y-004 - disabled-state semantics                                 */

test('A11Y-004: disabled states expose the disabled attribute - disconnected intake input and nothing-selected gate', async () => {
  test.slow()
  const srv = await startCluster('A11Y-004')
  const app = client!.app
  const page = app.page
  const intake = page.getByRole('textbox', { name: 'Torrent magnet link or URL' })
  await intake.waitFor({ state: 'visible', timeout: 10_000 })

  // Part 1: stop the server relay -> connection drops -> intake input disabled.
  await srv.app.serverBridge<void>('stopServer()')
  await app.waitFor(
    'intake input disabled after disconnect',
    async () => (await intake.getAttribute('disabled')) !== null,
    { timeoutMs: 20_000 }
  )
  expect(await intake.isEnabled()).toBe(false)
  expect(await intake.getAttribute('disabled'), 'disabled must be a real attribute, not just styling').not.toBeNull()
  await app.screenshot('a11y-004-intake-disabled-offline')

  // Recover so a draft can be created for part 2.
  await startRelay(srv.app)
  await app.waitFor('intake input re-enabled after reconnect', async () => {
    return (await intake.getAttribute('disabled')) === null
  }, { timeoutMs: 30_000 })

  // Part 2: selection gate - with NOTHING selected the primary action is
  // disabled via the real attribute. (Pre-preflight the primary action is
  // "Continue"; "Start" only exists post-preflight and is asserted enabled
  // below as the contrast case.)
  await submitIntake(app, E2E_MAGNET)
  await reachTree(app)
  await page.getByRole('button', { name: 'Select None' }).click()
  const gate = page.getByRole('button', { name: 'Continue', exact: true })
  await app.waitFor('nothing-selected gate disabled', async () => {
    return (await gate.getAttribute('disabled')) !== null
  })
  expect(await gate.isEnabled()).toBe(false)
  await app.screenshot('a11y-004-gate-disabled')

  // Contrast: select exactly one file -> gate enables; after preflight Start
  // is present and NOT disabled.
  await page.getByRole('checkbox', { name: 'sample.mkv' }).click()
  await app.waitFor('gate re-enabled after selecting a file', async () => {
    return (await gate.getAttribute('disabled')) === null
  })
  await continueToPreflight(app)
  const start = page.getByRole('button', { name: 'Start', exact: true })
  expect(await start.count()).toBe(1)
  expect(await start.getAttribute('disabled'), 'Start must be enabled with a valid preflight').toBeNull()
})

/* ------------------------------------------------------------------ */
/* A11Y-005 - FileTree accessible names                                */

test('A11Y-005: FileTree checkboxes expose file names; expand/collapse buttons expose aria-labels', async () => {
  await startCluster('A11Y-005')
  const app = client!.app
  const page = app.page
  await submitIntake(app, E2E_MAGNET)
  await reachTree(app)

  // Every file checkbox exposes an accessible name equal to the file name.
  for (const fileName of ['movie.mkv', 'sample.mkv', 'subs.srt']) {
    const box = page.getByRole('checkbox', { name: fileName, exact: true })
    expect(await box.count(), `checkbox named "${fileName}"`).toBe(1)
    await box.waitFor({ state: 'visible', timeout: 5_000 })
  }

  // Top-level folder starts expanded -> chevron reads "Collapse <name>".
  const collapse = page.getByRole('button', { name: 'Collapse Movie', exact: true })
  expect(await collapse.count()).toBe(1)

  // Collapse it: the label flips to "Expand <name>" and aria-expanded follows.
  await collapse.click()
  const expand = page.getByRole('button', { name: 'Expand Movie', exact: true })
  await expand.waitFor({ state: 'visible', timeout: 5_000 })
  const folderItem = page.getByRole('treeitem', { name: /Movie/ }).first()
  expect(await folderItem.getAttribute('aria-expanded')).toBe('false')
  await app.screenshot('a11y-005-collapsed')

  // Expand again.
  await expand.click()
  await page.getByRole('button', { name: 'Collapse Movie', exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
  expect(await folderItem.getAttribute('aria-expanded')).toBe('true')
})

/* ------------------------------------------------------------------ */
/* A11Y-006 - aria-live regions                                        */

test('A11Y-006: aria-live regions present - online-line polite, pairing countdown polite, status containers announced', async () => {
  const srv = await startCluster('A11Y-006', { pair: false })
  const app = srv.app
  const page = app.page

  // Dashboard online/offline line announces politely.
  const onlineLine = page.getByTestId('online-line')
  await onlineLine.waitFor({ state: 'visible', timeout: 15_000 })
  expect(await onlineLine.getAttribute('aria-live')).toBe('polite')

  // Pairing modal: countdown is a polite live region; the code itself is a
  // role=status container so code generation/expiry changes are announced.
  await page.getByTestId('pair-client').click()
  const countdown = page.getByTestId('pairing-countdown')
  await countdown.waitFor({ state: 'visible', timeout: 10_000 })
  expect(await countdown.getAttribute('aria-live')).toBe('polite')
  const pairingCode = page.getByTestId('pairing-code')
  await expect(pairingCode).toHaveAttribute('role', 'status')
  // role=status containers present while the modal is open (the code display;
  // the expired-state paragraph swaps into the same slot).
  expect(await page.getByRole('status').count()).toBeGreaterThanOrEqual(1)
  await app.screenshot('a11y-006-live-regions')
})
