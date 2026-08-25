import { test, expect } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { launchApp, type AppHandle } from './harness/app'
import { getFreePort } from './harness/paths'
import { createMockQbit, type MockQbit } from './harness/qbit-server'

/**
 * SETUP lane — first-run server setup wizard.
 * Per docs/E2E-EXHAUSTIVE-TEST-PLAN.md §SETUP (IDs SETUP-001..050).
 *
 * The wizard gates on settings.workingFolderPath === null (needsSetup in
 * src/renderer/server/state/setupMachine.ts), so wizard tests launch with
 * mode:'server' and NO dataDir override (DEFAULT_SETTINGS.dataDir is null).
 */

const launched: AppHandle[] = []
const mocks: MockQbit[] = []

async function closeAll(): Promise<void> {
  for (const app of launched.reverse()) await app.close()
  launched.length = 0
  for (const mock of mocks) await mock.close()
  mocks.length = 0
}

test.afterEach(async () => {
  await closeAll()
})

/* ------------------------------------------------------------------ */
/* helpers                                                             */

/** Launches a fresh server-mode app that lands on the setup wizard. */
async function launchWizard(testId: string, label = 'wizard'): Promise<AppHandle> {
  const app = await launchApp({
    testId,
    label,
    settings: { mode: 'server', serverPort: await getFreePort() }
  })
  launched.push(app)
  await expect(app.page.getByRole('heading', { name: 'Working folder' })).toBeVisible({ timeout: 15_000 })
  return app
}

function nextButton(page: Page): ReturnType<Page['getByTestId']> {
  return page.getByTestId('next-step')
}

function backButton(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('button', { name: 'Back' })
}

function stepHeading(page: Page, title: string): ReturnType<Page['getByRole']> {
  return page.getByRole('heading', { name: title })
}

async function goNext(app: AppHandle, fromTitle: string, toTitle: string): Promise<void> {
  await nextButton(app.page).click()
  await expect(stepHeading(app.page, toTitle)).toBeVisible()
}

/** Applies a folder path through the manual-path field and waits for the drive card. */
async function applyFolder(app: AppHandle, path: string): Promise<void> {
  await app.page.getByLabel('Or type a folder path').fill(path)
  await app.page.getByRole('button', { name: 'Use this folder' }).click()
  await expect(app.page.getByTestId('drive-info')).toBeVisible({ timeout: 15_000 })
}

function tempFolder(): string {
  return mkdtempSync(join(tmpdir(), 'vr-wizard-folder-'))
}

/**
 * Completes folder + radmin steps and lands on the qBittorrent step.
 * The Radmin step auto-completes on machines with a Radmin VPN adapter
 * (auto-selection in src/main/server/controller.ts radminStatus).
 */
async function walkToQbit(app: AppHandle): Promise<void> {
  await applyFolder(app, tempFolder())
  await goNext(app, 'Working folder', 'Radmin VPN')
  await expect(nextButton(app.page)).toBeEnabled({ timeout: 15_000 })
  await goNext(app, 'Radmin VPN', 'qBittorrent')
}

/** Completes the qBittorrent step against the given mock and lands on Viking. */
async function completeQbitStep(app: AppHandle, mockUrl: string, apiKey = 'e2e-qbit-key'): Promise<void> {
  await app.page.getByLabel('Web API').fill(mockUrl)
  await app.page.getByLabel('API Key').fill(apiKey)
  await app.page.getByRole('button', { name: 'Test' }).click()
  await expect(app.page.getByTestId('qbit-probe-ok')).toBeVisible({ timeout: 15_000 })
  await goNext(app, 'qBittorrent', 'Viking')
}

function vikingRadios(page: Page): ReturnType<Page['locator']> {
  return page.locator('input[name="viking-mode"]')
}

/** All bindable IPv4 candidates of THIS machine (mirrors collectIpv4Candidates).
 * Excludes APIPA (169.254/16) addresses, which appear/disappear as DHCP
 * completes, and requires the address to be present in two consecutive scans
 * so tests never pin an adapter that vanishes mid-test. */
function realNicCandidates(): Array<{ name: string; address: string }> {
  const scan = (): Set<string> => {
    const out = new Set<string>()
    for (const addrs of Object.values(networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (
          !addr.internal &&
          addr.family === 'IPv4' &&
          /^\d+\.\d+\.\d+\.\d+$/.test(addr.address) &&
          !addr.address.startsWith('169.254.')
        ) {
          out.add(addr.address)
        }
      }
    }
    return out
  }
  const first = scan()
  const second = scan()
  const stable = [...first].filter((a) => second.has(a))
  const named: Array<{ name: string; address: string }> = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && stable.includes(addr.address)) {
        named.push({ name, address: addr.address })
      }
    }
  }
  return named.sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address))
}

/* ------------------------------------------------------------------ */
/* SETUP-001..005 — wizard nav rules                                   */

test('SETUP-001: fresh server lands on wizard step 1 with Next gated and Back disabled', async () => {
  const app = await launchWizard('SETUP-001')
  // Step 1 active, no folder applied yet.
  await expect(app.page.getByText('1. Working folder')).toBeVisible()
  await expect(app.page.getByText('No working folder selected yet.')).toBeVisible()
  await expect(nextButton(app.page)).toBeDisabled()
  await expect(backButton(app.page)).toBeDisabled()
})

test('SETUP-002: Next unlocks only after the folder step completes', async () => {
  const app = await launchWizard('SETUP-002')
  await expect(nextButton(app.page)).toBeDisabled()
  await applyFolder(app, tempFolder())
  await expect(nextButton(app.page)).toBeEnabled()
})

test('SETUP-003: cannot jump ahead via the stepper', async () => {
  const app = await launchWizard('SETUP-003')
  // Stepper entries are display-only (li/div/span, no buttons) — clicking a
  // future step must leave the wizard on the current step.
  await app.page.getByText('4. Viking').click()
  await app.page.getByText('5. Ready').click()
  await expect(stepHeading(app.page, 'Working folder')).toBeVisible()
  await expect(stepHeading(app.page, 'Ready')).toHaveCount(0)
})

test('SETUP-004: Back returns to the previous step with state retained', async () => {
  const app = await launchWizard('SETUP-004')
  const folder = tempFolder()
  await applyFolder(app, folder)
  await goNext(app, 'Working folder', 'Radmin VPN')
  await backButton(app.page).click()
  await expect(stepHeading(app.page, 'Working folder')).toBeVisible()
  // Applied folder state survives the round trip.
  await expect(app.page.getByTestId('drive-info')).toBeVisible()
  await expect(app.page.getByText(folder)).toBeVisible()
})

test('SETUP-005: Ready step is gated until every preceding step is complete', async () => {
  const app = await launchWizard('SETUP-005')
  const mock = await createMockQbit({})
  mocks.push(mock)

  await walkToQbit(app)
  await completeQbitStep(app, mock.url)

  // Viking unconfigured -> Next (to Ready) must be gated.
  await expect(app.page.getByText('Loading Viking configuration…')).toHaveCount(0)
  await expect(nextButton(app.page)).toBeDisabled()

  await vikingRadios(app.page).nth(0).check() // Anonymous
  await expect(nextButton(app.page)).toBeEnabled({ timeout: 15_000 })
  await goNext(app, 'Viking', 'Ready')

  // Full checklist green + Start Server unlocked.
  for (const row of ['Storage', 'Radmin', 'qBittorrent', 'Viking']) {
    await expect(app.page.getByTestId(`ready-${row}`)).toContainText('✓ Ready')
  }
  await expect(app.page.getByTestId('start-server')).toBeEnabled()
})

/* ------------------------------------------------------------------ */
/* SETUP-010..013 — folder step                                        */

test('SETUP-010: valid folder applies as writable with drive info', async () => {
  const app = await launchWizard('SETUP-010')
  const folder = tempFolder()
  await applyFolder(app, folder)
  await expect(app.page.getByTestId('drive-free')).toBeVisible()
  await expect(app.page.getByText(folder)).toBeVisible()
  await expect(nextButton(app.page)).toBeEnabled()
})

test('SETUP-011: invalid folder path surfaces a truthful error and keeps Next gated', async () => {
  const app = await launchWizard('SETUP-011')
  // Characters illegal in Windows path components make mkdir fail.
  const badPath = join(tmpdir(), 'vr-invalid<<"*|">>path')
  await app.page.getByLabel('Or type a folder path').fill(badPath)
  await app.page.getByRole('button', { name: 'Use this folder' }).click()
  const alert = app.page.getByRole('alert')
  await expect(alert).toBeVisible({ timeout: 15_000 })
  await expect(alert).not.toBeEmpty()
  await expect(nextButton(app.page)).toBeDisabled()
})

test('SETUP-012: empty folder path is rejected (apply disabled)', async () => {
  const app = await launchWizard('SETUP-012')
  const apply = app.page.getByRole('button', { name: 'Use this folder' })
  await expect(apply).toBeDisabled()
  // Whitespace-only counts as empty.
  await app.page.getByLabel('Or type a folder path').fill('   ')
  await expect(apply).toBeDisabled()
})

test('SETUP-013: applied folder persists into server settings', async () => {
  const app = await launchWizard('SETUP-013')
  const folder = tempFolder()
  await applyFolder(app, folder)
  const settings = (await app.serverBridge<Record<string, unknown>>('getSettings()')) as Record<
    string,
    unknown
  >
  expect(settings['workingFolderPath']).toBe(folder)
})

/* ------------------------------------------------------------------ */
/* SETUP-020..022 — Radmin step                                        */

test('SETUP-020: radmin status lists real NIC candidates and the step reflects the adapter', async () => {
  const app = await launchWizard('SETUP-020')
  const nics = realNicCandidates()
  expect(nics.length).toBeGreaterThanOrEqual(1)

  const status = (await app.serverBridge<Record<string, unknown>>('getRadminStatus()')) as {
    detected: boolean
    connected: boolean
    ipv4: string | null
    candidates: Array<{ id: string; name: string; ipv4: string }>
  }
  expect(status.candidates.length).toBeGreaterThanOrEqual(1)
  const nicAddresses = new Set(nics.map((n) => n.address))
  for (const candidate of status.candidates) {
    expect(nicAddresses.has(candidate.ipv4)).toBe(true)
  }

  // The controller auto-selects a viable adapter (detected+connected even
  // without a literal Radmin-named NIC on this machine).
  expect(status.detected).toBe(true)
  expect(status.connected).toBe(true)
  expect(status.ipv4).toBeTruthy()

  // UI assertions require the wizard to BE on the Radmin step.
  await applyFolder(app, tempFolder())
  await goNext(app, 'Working folder', 'Radmin VPN')
  await expect(app.page.getByText(/Adapter found/)).toBeVisible()
  await expect(app.page.getByText(String(status.ipv4)).first()).toBeVisible()
  const port = String(((await app.serverBridge<Record<string, unknown>>('getSettings()')) as Record<string, unknown>)['relayPort'])
  await expect(app.page.getByTestId('server-address')).toHaveText(`${status.ipv4}:${port}`)
})

test('SETUP-021: pinning an interface records radminInterfaceId in settings', async () => {
  const app = await launchWizard('SETUP-021')
  // Pin an address from the PRODUCT's live candidate list (when a Radmin
  // adapter exists, the product restricts candidates to it — raw OS NIC
  // enumeration is not the contract).
  const status0 = (await app.serverBridge<Record<string, unknown>>('getRadminStatus()')) as {
    candidates: Array<{ id: string; ipv4: string }>
  }
  expect(status0.candidates.length).toBeGreaterThanOrEqual(1)
  const pin = status0.candidates[0]!.id

  const status = (await app.serverBridge<Record<string, unknown>>(
    `selectRadminInterface("${pin}")`
  )) as { selectedId: string | null; connected: boolean; ipv4: string | null }
  expect(status.selectedId).toBe(pin)
  expect(status.connected).toBe(true)
  expect(status.ipv4).toBe(pin)

  const settings = (await app.serverBridge<Record<string, unknown>>('getSettings()')) as Record<
    string,
    unknown
  >
  expect(settings['radminInterfaceId']).toBe(pin)
})

test('SETUP-022: refreshed radmin status stays consistent and keeps the pin', async () => {
  const app = await launchWizard('SETUP-022')
  const status0 = (await app.serverBridge<Record<string, unknown>>('getRadminStatus()')) as {
    candidates: Array<{ id: string; ipv4: string }>
  }
  expect(status0.candidates.length).toBeGreaterThanOrEqual(1)
  const pin = status0.candidates[0]!.id
  await app.serverBridge(`selectRadminInterface("${pin}")`)

  // Refresh = re-query the same bridge call the step's retry/refresh path uses.
  const first = (await app.serverBridge<Record<string, unknown>>('getRadminStatus()')) as {
    selectedId: string | null
    candidates: unknown[]
  }
  const second = (await app.serverBridge<Record<string, unknown>>('getRadminStatus()')) as {
    selectedId: string | null
    candidates: Array<{ id: string }>
  }
  expect(first.selectedId).toBe(pin)
  expect(second.selectedId).toBe(pin)
  expect(second.candidates.length).toBeGreaterThanOrEqual(1)
  expect(second.candidates.map((c) => c.id).sort()).toEqual(
    first.candidates === null ? [] : (first.candidates as Array<{ id: string }>).map((c) => c.id).sort()
  )
})

/* ------------------------------------------------------------------ */
/* SETUP-030..033 — qBittorrent step                                   */

test('SETUP-030: probe ok against mock qBittorrent v5.2.0 unlocks the step', async () => {
  const app = await launchWizard('SETUP-030')
  const mock = await createMockQbit({ appVersion: 'v5.2.0' })
  mocks.push(mock)
  await walkToQbit(app)
  await app.page.getByLabel('Web API').fill(mock.url)
  await app.page.getByLabel('API Key').fill('e2e-qbit-key')
  await app.page.getByRole('button', { name: 'Test' }).click()
  const ok = app.page.getByTestId('qbit-probe-ok')
  await expect(ok).toBeVisible({ timeout: 15_000 })
  await expect(ok).toContainText('qBittorrent connected')
  await expect(ok).toContainText('v5.2.0')
  await expect(nextButton(app.page)).toBeEnabled()
})

test('SETUP-031: unsupported qBittorrent version is rejected', async () => {
  const app = await launchWizard('SETUP-031')
  const mock = await createMockQbit({ appVersion: 'v4.8.0' })
  mocks.push(mock)
  await walkToQbit(app)
  await app.page.getByLabel('Web API').fill(mock.url)
  await app.page.getByLabel('API Key').fill('e2e-qbit-key')
  await app.page.getByRole('button', { name: 'Test' }).click()
  const error = app.page.getByTestId('qbit-probe-error')
  await expect(error).toBeVisible({ timeout: 15_000 })
  await expect(error).toContainText('5.2 or newer')
  await expect(nextButton(app.page)).toBeDisabled()
})

test('SETUP-032: malformed Web API URL surfaces the invalid-url error', async () => {
  const app = await launchWizard('SETUP-032')
  await walkToQbit(app)
  await app.page.getByLabel('Web API').fill('not a valid url')
  await app.page.getByRole('button', { name: 'Test' }).click()
  const error = app.page.getByTestId('qbit-probe-error')
  await expect(error).toBeVisible({ timeout: 15_000 })
  await expect(error).toContainText("doesn't look valid")
  await expect(nextButton(app.page)).toBeDisabled()
})

test('SETUP-033: API key entered with a successful probe is saved securely', async () => {
  const app = await launchWizard('SETUP-033')
  const mock = await createMockQbit({})
  mocks.push(mock)
  await walkToQbit(app)
  await app.page.getByLabel('Web API').fill(mock.url)
  await app.page.getByLabel('API Key').fill('e2e-qbit-key')
  await app.page.getByRole('button', { name: 'Test' }).click()
  await expect(app.page.getByTestId('qbit-probe-ok')).toBeVisible({ timeout: 15_000 })
  await expect(app.page.getByText('API key saved securely on this machine.')).toBeVisible()
  const settings = (await app.serverBridge<Record<string, unknown>>('getSettings()')) as Record<
    string,
    unknown
  >
  expect(settings['qbitApiKeySet']).toBe(true)
})

/* ------------------------------------------------------------------ */
/* SETUP-040..042 — Viking step                                        */

test('SETUP-040: anonymous upload mode is accepted and completes the step', async () => {
  const app = await launchWizard('SETUP-040')
  const mock = await createMockQbit({})
  mocks.push(mock)
  await walkToQbit(app)
  await completeQbitStep(app, mock.url)

  await expect(nextButton(app.page)).toBeDisabled()
  await vikingRadios(app.page).nth(0).check()
  // Anonymous choice: radio checks and the step completes (Next unlocks).
  await expect(vikingRadios(app.page).nth(0)).toBeChecked({ timeout: 15_000 })
  await expect(nextButton(app.page)).toBeEnabled({ timeout: 15_000 })
  // Nothing is persisted for anonymous by design — a later plain config query
  // reports 'unconfigured' until a hash is saved; the wizard holds the choice.
  const config = (await app.serverBridge<Record<string, unknown>>('getVikingConfig()')) as Record<
    string,
    unknown
  >
  expect(config['mode']).not.toBe('user_hash')
})

test('SETUP-041: saving a user hash records it masked and completes the step', async () => {
  const app = await launchWizard('SETUP-041')
  const mock = await createMockQbit({})
  mocks.push(mock)
  await walkToQbit(app)
  await completeQbitStep(app, mock.url)

  await vikingRadios(app.page).nth(1).check() // Viking account (user hash)
  await app.page.getByLabel('Viking user hash').fill('e2e-viking-user-hash-secret')
  await app.page.getByRole('button', { name: 'Save hash' }).click()

  // Product truth: saved-status line + step completes + config reflects hash.
  await expect(app.page.getByText('User hash saved securely on this machine.')).toBeVisible({
    timeout: 20_000
  })
  await expect(nextButton(app.page)).toBeEnabled({ timeout: 15_000 })

  const config = (await app.serverBridge<Record<string, unknown>>('getVikingConfig()')) as Record<
    string,
    unknown
  >
  expect(config['mode']).toBe('user_hash')
  // maskSecret format: first3<sep>last3 (ellipsis separator) — never the raw secret.
  expect(String(config['userHashMasked'])).toMatch(/^[A-Za-z0-9]+[….][A-Za-z0-9]+$/)
  expect(String(config['userHashMasked'])).not.toBe('e2e-viking-user-hash-secret')
  expect(JSON.stringify(config)).not.toContain('e2e-viking-user-hash-secret')
})

test('SETUP-042: empty user hash is rejected client-side (save gated)', async () => {
  const app = await launchWizard('SETUP-042')
  const mock = await createMockQbit({})
  mocks.push(mock)
  await walkToQbit(app)
  await completeQbitStep(app, mock.url)

  await vikingRadios(app.page).nth(1).check()
  const save = app.page.getByRole('button', { name: 'Save hash' })
  await expect(save).toBeDisabled()
  // NOTE: the backend accepts any non-empty hash string (no server-side
  // validation surface exists) — see report: validation is client-side only.
  const config = (await app.serverBridge<Record<string, unknown>>('getVikingConfig()')) as Record<
    string,
    unknown
  >
  expect(config['mode']).not.toBe('user_hash')
})

/* ------------------------------------------------------------------ */
/* SETUP-050 — finish                                                  */

test('SETUP-050: finishing the wizard starts the server and mounts the Dashboard', async () => {
  const mock = await createMockQbit({})
  mocks.push(mock)
  const app = await launchApp({
    testId: 'SETUP-050',
    label: 'wizard-final',
    settings: {
      mode: 'server',
      serverPort: await getFreePort(),
      qbittorrentBaseUrl: mock.url
    }
  })
  launched.push(app)
  await expect(stepHeading(app.page, 'Working folder')).toBeVisible({ timeout: 15_000 })

  await applyFolder(app, tempFolder())
  await goNext(app, 'Working folder', 'Radmin VPN')
  await expect(nextButton(app.page)).toBeEnabled({ timeout: 15_000 })
  await goNext(app, 'Radmin VPN', 'qBittorrent')
  await completeQbitStep(app, mock.url)
  await vikingRadios(app.page).nth(0).check()
  await expect(nextButton(app.page)).toBeEnabled({ timeout: 15_000 })
  await goNext(app, 'Viking', 'Ready')

  await app.page.getByTestId('start-server').click()

  // Dashboard mounts (wizard gone) and the relay reports online.
  await expect(app.page.getByTestId('pair-client')).toBeVisible({ timeout: 20_000 })
  await app.waitFor('relay online after wizard finish', async () => {
    const health = (await app.serverBridge<Record<string, unknown>>('getHealth()')) as Record<
      string,
      unknown
    >
    return health['online'] === true
    },
    { timeoutMs: 20_000 }
  )
})
