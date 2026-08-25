import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchApp, type AppHandle } from './harness/app'
import {
  E2E_MAGNET,
  expectVisible,
  fillField,
  launchServer,
  pairClient,
  type PairedClient,
  type ServerCluster
} from './harness/cluster'
import { getFreePort } from './harness/paths'

/**
 * AUTH + PERM lanes — pairing via the real ConnectScreen UI against a live
 * relay, PairingModal behavior, revocation and tenant isolation.
 * Per docs/E2E-EXHAUSTIVE-TEST-PLAN.md §AUTH/PERM.
 */

const servers: ServerCluster[] = []
const clients: AppHandle[] = []

async function closeAll(): Promise<void> {
  for (const c of clients.reverse()) await c.close()
  clients.length = 0
  for (const s of servers.reverse()) await s.close()
  servers.length = 0
}

test.afterEach(async () => {
  await closeAll()
})

/* ------------------------------------------------------------------ */
/* helpers                                                             */

/** Opens the Dashboard pairing modal through the real UI and returns the code. */
async function openPairingModal(server: ServerCluster): Promise<string> {
  await server.app.page.getByTestId('pair-client').click()
  const codeLoc = server.app.page.getByTestId('pairing-code')
  await codeLoc.waitFor({ state: 'visible', timeout: 10_000 })
  return (await codeLoc.textContent()) ?? ''
}

/** Fills the ConnectScreen form and submits it (real UI path). */
async function submitConnectForm(
  page: Page,
  host: string,
  port: string,
  code: string
): Promise<void> {
  await fillField(page, 'Server IP', host)
  await fillField(page, 'Port', port)
  await fillField(page, 'Pairing Code', code)
}

function connectError(page: Page): ReturnType<Page['getByText']> {
  return page.getByText(/pairing code|Port must|unreachable|valid IP|Enter the server/i).first()
}

async function waitForConnectedHome(client: AppHandle): Promise<void> {
  await client.waitFor(
    'client reaches connected home screen',
    async () => {
      try {
        const conn = (await client.page.evaluate(() =>
          window.vikingClientBridge.getConnection()
        )) as { host?: string } | null | undefined
        return Boolean(conn && conn.host)
      } catch {
        return false
      }
    },
    { timeoutMs: 20_000 }
  )
}

/** Mutates one character of a valid code so it no longer matches. */
function wrongCode(code: string): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const raw = code.replace(/[\s-]+/g, '').toUpperCase()
  const first = raw[0] ?? 'A'
  const replacement = first === 'X' ? 'Y' : 'X'
  return replacement + raw.slice(1) === raw ? alphabet[0] + raw.slice(1) : replacement + raw.slice(1)
}

/* ------------------------------------------------------------------ */
/* AUTH-001..009 — connect screen flows                                */

test('AUTH-001: client pairs via real UI against live relay and lands connected', async () => {
  const server = await launchServer({ testId: 'AUTH-001', label: 'server' })
  servers.push(server)
  const code = await openPairingModal(server)

  const client = await launchApp({ testId: 'AUTH-001', label: 'client', settings: { mode: 'client' } })
  clients.push(client)
  await expectVisible(client, 'Pair & Connect')
  await submitConnectForm(client.page, server.relayAddress, String(server.relayPort), code)
  await client.page.getByRole('button', { name: /Pair & Connect/ }).click()

  await waitForConnectedHome(client)
  // Home screen mounted with an enabled intake form.
  await expect(client.page.getByLabel('Torrent magnet link or URL')).toBeEnabled({ timeout: 15_000 })
})

test('AUTH-002: wrong pairing code fails with a truthful inline error', async () => {
  const server = await launchServer({ testId: 'AUTH-002', label: 'server' })
  servers.push(server)
  const code = await openPairingModal(server)

  const client = await launchApp({ testId: 'AUTH-002', label: 'client', settings: { mode: 'client' } })
  clients.push(client)
  await expectVisible(client, 'Pair & Connect')
  await submitConnectForm(client.page, server.relayAddress, String(server.relayPort), wrongCode(code))
  await client.page.getByRole('button', { name: /Pair & Connect/ }).click()

  await expect(connectError(client.page)).toBeVisible({ timeout: 15_000 })
  await expect(client.page.getByText('the pairing code was not accepted')).toBeVisible()
  // Still unpaired.
  const conn = (await client.clientBridge<{ host?: string } | null>('getConnection()')) as {
    host?: string
  } | null
  expect(conn).toBeNull()
})

test('AUTH-003: malformed code is rejected client-side by the 8-char rule', async () => {
  const client = await launchApp({ testId: 'AUTH-003', label: 'client', settings: { mode: 'client' } })
  clients.push(client)
  await expectVisible(client, 'Pair & Connect')
  await submitConnectForm(client.page, '127.0.0.1', '47821', 'ABC')
  await client.page.getByRole('button', { name: /Pair & Connect/ }).click()

  await expect(
    client.page.getByText('Pairing code must be 8 characters — with or without the dash (XXXX-XXXX).')
  ).toBeVisible()
  // Validation is local: still on the connect screen, nothing paired.
  await expectVisible(client, 'Pair & Connect')
})

test('AUTH-004: unreachable host surfaces the server_unreachable error', async () => {
  const deadPort = await getFreePort() // bound+closed: nothing listens here
  const client = await launchApp({ testId: 'AUTH-004', label: 'client', settings: { mode: 'client' } })
  clients.push(client)
  await expectVisible(client, 'Pair & Connect')
  await submitConnectForm(client.page, '127.0.0.1', String(deadPort), 'ABCD2345')
  await client.page.getByRole('button', { name: /Pair & Connect/ }).click()

  await expect(client.page.getByText(/unreachable/i)).toBeVisible({ timeout: 20_000 })
})

test('AUTH-005: invalid port values are rejected with a range message', async () => {
  const client = await launchApp({ testId: 'AUTH-005', label: 'client', settings: { mode: 'client' } })
  clients.push(client)
  await expectVisible(client, 'Pair & Connect')

  for (const badPort of ['70000', '0', 'abc']) {
    await submitConnectForm(client.page, '127.0.0.1', badPort, 'ABCD2345')
    await client.page.getByRole('button', { name: /Pair & Connect/ }).click()
    await expect(client.page.getByText('Port must be between 1 and 65535.')).toBeVisible()
  }
})

test('AUTH-006: lowercase dashed code is normalized and accepted', async () => {
  const server = await launchServer({ testId: 'AUTH-006', label: 'server' })
  servers.push(server)
  const generated = (await server.app.serverBridge<Record<string, unknown>>(
    'generatePairingCode()'
  )) as { code: string }
  const raw = generated.code.replace(/[\s-]+/g, '')
  const display = `${raw.slice(0, 4)}-${raw.slice(4)}`.toLowerCase()

  const client = await launchApp({ testId: 'AUTH-006', label: 'client', settings: { mode: 'client' } })
  clients.push(client)
  await expectVisible(client, 'Pair & Connect')
  await submitConnectForm(client.page, server.relayAddress, String(server.relayPort), display)
  await client.page.getByRole('button', { name: /Pair & Connect/ }).click()

  await waitForConnectedHome(client)
})

test('AUTH-007: Save & Reconnect change-server mode reconnects to the same relay', async () => {
  const server = await launchServer({ testId: 'AUTH-007', label: 'server' })
  servers.push(server)
  const paired = await pairClient({ testId: 'AUTH-007', server, name: 'reconnector' })
  clients.push(paired.app)

  // Enter change-server mode from the home header.
  await paired.app.page.getByRole('button', { name: 'Change Server' }).click()
  await expectVisible(paired.app, 'Change server address')
  await expect(paired.app.page.getByRole('button', { name: /Save & Reconnect/ })).toBeVisible()

  // Fields are prefilled with the saved connection.
  const hostInput = paired.app.page.getByText('Server IP', { exact: true }).first().locator('xpath=following::input[1]')
  const portInput = paired.app.page.getByText('Port', { exact: true }).first().locator('xpath=following::input[1]')
  expect(await hostInput.inputValue()).toBe(server.relayAddress)
  expect(await portInput.inputValue()).toBe(String(server.relayPort))

  // Reconnect with a fresh code.
  const generated = (await server.app.serverBridge<Record<string, unknown>>(
    'generatePairingCode()'
  )) as { code: string }
  await fillField(paired.app.page, 'Pairing Code', generated.code)
  await paired.app.page.getByRole('button', { name: /Save & Reconnect/ }).click()

  await paired.app.waitFor(
    'back on connected home after Save & Reconnect',
    async () => {
      const status = (await paired.app.clientBridge<Record<string, unknown>>('connectionStatus()')) as Record<string, unknown>
      return status['state'] === 'connected'
    },
    { timeoutMs: 20_000 }
  )
  await expect(paired.app.page.getByLabel('Torrent magnet link or URL')).toBeVisible({ timeout: 15_000 })
})

test('AUTH-008: cancelling change-server keeps the existing connection', async () => {
  const server = await launchServer({ testId: 'AUTH-008', label: 'server' })
  servers.push(server)
  const paired = await pairClient({ testId: 'AUTH-008', server, name: 'canceller' })
  clients.push(paired.app)

  await paired.app.page.getByRole('button', { name: 'Change Server' }).click()
  await expectVisible(paired.app, 'Change server address')
  await paired.app.page.getByRole('button', { name: 'Back' }).click()

  // Back returns home; connection untouched.
  await expect(paired.app.page.getByLabel('Torrent magnet link or URL')).toBeVisible({ timeout: 15_000 })
  await paired.app.waitFor(
    'connection still connected after cancel',
    async () => {
      const status = (await paired.app.clientBridge<Record<string, unknown>>('connectionStatus()')) as Record<string, unknown>
      return status['state'] === 'connected'
    },
    { timeoutMs: 10_000 }
  )
  await expect(paired.app.page.getByLabel('Torrent magnet link or URL')).toBeEnabled()
})

test('AUTH-009: forget clears the token + host and next boot lands on Connect', async () => {
  const server = await launchServer({ testId: 'AUTH-009', label: 'server' })
  servers.push(server)
  const paired = await pairClient({ testId: 'AUTH-009', server, name: 'forgetter' })

  // NOTE: there is no Forget affordance in the client UI (only Change Server);
  // the bridge surface is exercised directly — gap reported to orchestrator.
  await paired.app.clientBridge('forgetConnection()')

  const conn = (await paired.app.clientBridge<{ host?: string } | null>('getConnection()')) as {
    host?: string
  } | null
  expect(conn).toBeNull()
  const status = (await paired.app.clientBridge<Record<string, unknown>>('connectionStatus()')) as Record<string, unknown>
  expect(status['state']).toBe('unpaired')

  // Persisted settings no longer carry the server host.
  const persisted = paired.app.readPersisted('settings.json')
  expect(persisted).toBeTruthy()
  expect(JSON.parse(persisted!)).toMatchObject({ clientServerHost: null })
  await paired.close()

  // Restart semantics: re-seed a fresh dir with the exact persisted bytes.
  const restarted = await launchApp({
    testId: 'AUTH-009',
    label: 'restarted',
    settings: JSON.parse(persisted!) as Record<string, never>
  })
  clients.push(restarted)
  await expect(restarted.page.getByRole('button', { name: /Pair & Connect/ })).toBeVisible({
    timeout: 15_000
  })
})

/* ------------------------------------------------------------------ */
/* AUTH-020..023 — PairingModal                                        */

test('AUTH-020: opening the modal auto-generates a grouped 8-char code', async () => {
  const server = await launchServer({ testId: 'AUTH-020', label: 'server' })
  servers.push(server)
  const code = await openPairingModal(server)
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  for (const ch of code.replace('-', '')) {
    expect('ABCDEFGHJKMNPQRSTUVWXYZ23456789').toContain(ch)
  }
})

test('AUTH-021: regenerate replaces the active code', async () => {
  const server = await launchServer({ testId: 'AUTH-021', label: 'server' })
  servers.push(server)
  const first = await openPairingModal(server)
  await server.app.page.getByTestId('pairing-regenerate').click()
  await server.app.waitFor(
    'pairing code changes after regenerate',
    async () => {
      const current = (await server.app.page.getByTestId('pairing-code').textContent()) ?? ''
      return current !== first && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(current)
    },
    { timeoutMs: 10_000 }
  )
})

test('AUTH-022: modal shows a live TTL countdown', async () => {
  const server = await launchServer({ testId: 'AUTH-022', label: 'server' })
  servers.push(server)
  await openPairingModal(server)
  const countdown = server.app.page.getByTestId('pairing-countdown')
  await expect(countdown).toBeVisible()
  await expect(countdown).toContainText('Expires in')
  await expect(countdown).toContainText(/\d{2}:\d{2}/)
})

test('AUTH-023: paired client appears in the server roster list', async () => {
  const server = await launchServer({ testId: 'AUTH-023', label: 'server' })
  servers.push(server)
  const paired = await pairClient({ testId: 'AUTH-023', server, name: 'roster-client' })
  clients.push(paired.app)

  await server.app.page.getByTestId('open-settings').click()
  const section = server.app.page.getByTestId('paired-clients-section')
  await expect(section).toBeVisible({ timeout: 15_000 })
  await expect(section.getByText('paired-client').first()).toBeVisible()
  await expect(section.getByRole('button', { name: 'Disconnect' })).toHaveCount(1)
})

/* ------------------------------------------------------------------ */
/* PERM-001..002 — revocation + tenant isolation                       */

test('PERM-001: revoked client drops to offline/disconnected and its API calls 401', async () => {
  const server = await launchServer({ testId: 'PERM-001', label: 'server' })
  servers.push(server)
  const victim = await pairClient({ testId: 'PERM-001', server, name: 'victim' })
  clients.push(victim.app)

  const roster = (await server.app.serverBridge<Array<{ clientId: string }>>(
    'listPairedClients()'
  )) as Array<{ clientId: string }>
  expect(roster).toHaveLength(1)
  const revoke = (await server.app.serverBridge<Record<string, unknown>>(
    `revokePairedClient("${roster[0]!.clientId}")`
  )) as Record<string, unknown>
  expect(revoke['removed']).toBe(true)
  expect(await server.app.serverBridge<Array<unknown>>('listPairedClients()')).toHaveLength(0)

  // Client UI surfaces the disconnected state within the bounded poll window.
  await victim.app.waitFor(
    'revoked client observes offline state',
    async () => {
      const status = (await victim.app.clientBridge<Record<string, unknown>>('connectionStatus()')) as Record<string, unknown>
      return status['state'] === 'offline'
    },
    { timeoutMs: 15_000 }
  )
  await expect(victim.app.page.getByText('offline', { exact: true }).first()).toBeVisible()
  await expect(victim.app.page.getByLabel('Torrent magnet link or URL')).toBeDisabled()

  // The revoked token now gets 401 from the relay (surfaced message).
  let intakeError = ''
  try {
    await victim.app.clientBridge(`createIntake("${E2E_MAGNET}")`)
  } catch (err) {
    intakeError = String(err)
  }
  expect(intakeError).toContain('not authorized on this server')
})

test('PERM-002: two clients see each other in the roster but not each other jobs', async () => {
  const server = await launchServer({ testId: 'PERM-002', label: 'server' })
  servers.push(server)
  const alice = await pairClient({ testId: 'PERM-002', server, name: 'alice' })
  const bob = await pairClient({ testId: 'PERM-002', server, name: 'bob' })
  clients.push(alice.app, bob.app)

  // Roster: each client sees exactly the OTHER client (never itself).
  const rosterAlice = (await alice.app.clientBridge<Array<{ clientId: string }>>('clientsList()')) as Array<{ clientId: string }>
  const rosterBob = (await bob.app.clientBridge<Array<{ clientId: string }>>('clientsList()')) as Array<{ clientId: string }>
  expect(rosterAlice).toHaveLength(1)
  expect(rosterBob).toHaveLength(1)
  expect(rosterAlice[0]!.clientId).not.toBe(rosterBob[0]!.clientId)

  // Alice creates then cancels a job (terminal -> would appear in history).
  const created = (await alice.app.clientBridge<{ jobId: string }>(
    `createIntake("${E2E_MAGNET}")`
  )) as { jobId: string }
  await alice.app.clientBridge(`cancelJob("${created.jobId}")`)
  await server.app.waitFor(
    'alice job reaches server history',
    async () => {
      const hist = (await server.app.serverBridge<Array<{ id: string }>>('getHistory(50)')) as Array<{ id: string }>
      return hist.some((h) => h.id === created.jobId)
    },
    { timeoutMs: 15_000 }
  )

  // Tenant isolation over the relay API: bob's history must NOT contain
  // alice's job; alice must still see her own.
  await server.app.waitFor(
    'alice history contains her cancelled job',
    async () => {
      const hist = (await alice.app.clientBridge<Array<{ id: string }>>('listHistory()')) as Array<{ id: string }>
      return hist.some((h) => h.id === created.jobId)
    },
    { timeoutMs: 15_000 }
  )
  const bobHist = (await bob.app.clientBridge<Array<{ id: string }>>('listHistory()')) as Array<{ id: string }>
  expect(bobHist.some((h) => h.id === created.jobId)).toBe(false)

  // Bob opens his History screen: alice's job must NOT be visible.
  await bob.app.page.getByRole('button', { name: 'History' }).click()
  await expect(bob.app.page.getByText('No jobs yet')).toBeVisible({ timeout: 15_000 })
  expect(await bob.app.page.getByText(/Movie 2024/i).count()).toBe(0)

  // MUTATION isolation (PERM-002 extension): a paired-but-foreign client must
  // NOT be able to cancel/mutate alice's job by id. Bob's own UI token stays
  // in main-process safeStorage (never exposed to the harness), so the
  // foreign caller is a second raw-paired credential over the real /v1/pair
  // endpoint — same scoping rule applies to ANY clientId != owner.
  const codeRes = await server.app.serverBridge<Record<string, unknown>>('generatePairingCode()')
  const rawCode = (codeRes as Record<string, unknown>)['code']
  if (typeof rawCode !== 'string') throw new Error(`no pairing code: ${JSON.stringify(codeRes)}`)
  const pairRes = await fetch(
    `http://${server.relayAddress}:${server.relayPort}/v1/pair`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: rawCode, name: 'mallory' }) }
  )
  expect(pairRes.status).toBe(200)
  const mallory = (await pairRes.json()) as { clientId: string; token: string }
  const authHeaders = { Authorization: `Bearer ${mallory.token}` }

  // Foreign cancel on alice's job → 404 job_not_found (existence not leaked),
  // even though the job is terminal: terminal no-op semantics apply ONLY to
  // the owning client.
  const base = `http://${server.relayAddress}:${server.relayPort}`
  for (const path of [
    `/v1/jobs/${created.jobId}/cancel`,
    `/v1/jobs/${created.jobId}/retry-packaging`,
    `/v1/jobs/${created.jobId}/retry-upload`,
    `/v1/jobs/${created.jobId}/recheck-storage`
  ]) {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: authHeaders })
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['error']).toBe('job_not_found')
  }

  // Control: alice's OWN mutation path still works — her earlier
  // clientBridge cancelJob() above succeeded against the same scoping rule,
  // and the job remains hers (visible in her history, asserted above).
})
