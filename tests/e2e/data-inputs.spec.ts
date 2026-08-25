import { test, expect } from '@playwright/test'
import type { AppHandle } from './harness/app'
import { E2E_MAGNET, launchServer, pairClient, type PairedClient, type ServerCluster } from './harness/cluster'
import { getFreePort } from './harness/paths'

/**
 * DATA lane — intake input matrix, duplicate/idempotency, friend edge cases.
 * Per docs/E2E-EXHAUSTIVE-TEST-PLAN.md §DATA (DATA-001..031).
 *
 * Local validation contract (src/renderer/client/screens/HomeScreen.tsx):
 *   empty            → "Paste a magnet link or a torrent URL."
 *   magnet w/o btih  → "That magnet link is missing its info hash (xt=urn:btih:…)."
 *   non-magnet/url   → "Enter a magnet URI or an HTTP(S) URL pointing to a .torrent file."
 * Server schema (src/main/relay/http/schemas.ts): magnet ≤ 4096, http(s) URL ≤ 2048.
 */

const HEX40 = '0123456789abcdef0123456789abcdef01234567'

let server: ServerCluster | null = null
const clients: PairedClient[] = []

test.afterEach(async () => {
  for (const c of clients) await c.close().catch(() => undefined)
  clients.length = 0
  if (server) {
    await server.close()
    server = null
  }
})

async function pairedHome(testId: string): Promise<AppHandle> {
  // Callers must have assigned `server` first.
  const client = await pairClient({ testId, server: server! })
  clients.push(client)
  return client.app
}

async function submitOnHome(app: AppHandle, text: string): Promise<void> {
  const input = app.page.getByLabel('Torrent magnet link or URL')
  await input.waitFor({ state: 'visible', timeout: 15_000 })
  await input.fill(text)
  await app.page.getByRole('button', { name: 'Continue' }).click()
}

function readJobs(_app: AppHandle): Array<Record<string, unknown>> {
  // Job history persists in the SERVER instance's userData; the client never
  // writes it. Callers pass the client handle — resolve the module-level server.
  const raw = server!.app.readPersisted('data/job-history.json')
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
/* DATA-001..008 — blocked / rejected inputs                           */

test('DATA-001: empty input → blocked with truthful message, no intake', async () => {
  server = await launchServer({ testId: 'DATA-001' })
  const app = await pairedHome('DATA-001')

  await submitOnHome(app, '')
  await expect(app.page.getByRole('alert')).toHaveText('Paste a magnet link or a torrent URL.')
  // Still on Home — nothing was submitted.
  await expect(app.page.getByLabel('Torrent magnet link or URL')).toBeVisible()
  expect(readJobs(app)).toHaveLength(0)
})

test('DATA-002: whitespace-only input → blocked with truthful message, no intake', async () => {
  server = await launchServer({ testId: 'DATA-002' })
  const app = await pairedHome('DATA-002')

  await submitOnHome(app, '   \t  ')
  await expect(app.page.getByRole('alert')).toHaveText('Paste a magnet link or a torrent URL.')
  expect(readJobs(app)).toHaveLength(0)
})

test('DATA-003: unicode+emoji magnet-shaped string → rejected as missing info hash, no crash', async () => {
  server = await launchServer({ testId: 'DATA-003' })
  const app = await pairedHome('DATA-003')

  await submitOnHome(app, `magnet:?xt=urn:btih:${'🎉'}中文${'✨'}`)
  await expect(app.page.getByRole('alert')).toHaveText(
    'That magnet link is missing its info hash (xt=urn:btih:…).'
  )
  expect(readJobs(app)).toHaveLength(0)
})

test('DATA-004: newline-containing input is trimmed and accepted', async () => {
  server = await launchServer({ testId: 'DATA-004' })
  const app = await pairedHome('DATA-004')

  // Trailing newline + tabs pass validation and are trimmed before submit.
  await submitOnHome(app, `${E2E_MAGNET}\n\t `)
  await app.waitFor(
    'selection screen reached with trimmed magnet',
    async () => app.page.getByText('Movie 2024', { exact: false }).first().isVisible().catch(() => false),
    { timeoutMs: 25_000 }
  )
})

test('DATA-005: reserved-characters URL pointing at a dead local port → truthful error surface, no crash', async () => {
  const deadPort = await getFreePort() // bound then released → connection refused
  server = await launchServer({ testId: 'DATA-005' })
  const app = await pairedHome('DATA-005')

  const baselineErrors = app.pageErrorCount()
  // Reserved chars < > | are accepted by the local URL check (\S+, http(s));
  // the .bin suffix routes it to the DIRECT download path, whose probe fails
  // instantly against the closed port. No external network is touched.
  await submitOnHome(app, `http://127.0.0.1:${deadPort}/<p|a>yload.bin`)

  await app.waitFor(
    'error screen shown for refused direct probe',
    async () => {
      const h1 = await app.page.locator('h1').first().textContent().catch(() => null)
      return h1 === 'Server unreachable' || h1 === 'Metadata unavailable' || h1 === 'Something went wrong'
    },
    { timeoutMs: 30_000 }
  )
  expect(app.pageErrorCount()).toBe(baselineErrors)
})

test('DATA-006: >4096-char magnet → rejected by server schema with visible error notice', async () => {
  server = await launchServer({ testId: 'DATA-006' })
  const app = await pairedHome('DATA-006')

  const oversized = `magnet:?xt=urn:btih:${'a'.repeat(4200)}`
  await submitOnHome(app, oversized)

  // Local regex accepts it; the relay schema (max 4096) rejects with 400 and
  // the Shell surfaces the error as a red alert banner under the header.
  await app.waitFor(
    'submit error notice visible',
    async () => {
      const notice = app.page.locator('header p[role="alert"]')
      const text = await notice.textContent().catch(() => null)
      return Boolean(text && text.trim().length > 0)
    },
    { timeoutMs: 15_000 }
  )
  // No intake draft was created server-side.
  expect(readJobs(app)).toHaveLength(0)
})

test('DATA-007: >2048-char http URL → rejected by server schema with visible error notice', async () => {
  server = await launchServer({ testId: 'DATA-007' })
  const app = await pairedHome('DATA-007')

  const oversized = `http://127.0.0.1:9/${'a'.repeat(2100)}`
  await submitOnHome(app, oversized)

  await app.waitFor(
    'submit error notice visible',
    async () => {
      const notice = app.page.locator('header p[role="alert"]')
      const text = await notice.textContent().catch(() => null)
      return Boolean(text && text.trim().length > 0)
    },
    { timeoutMs: 15_000 }
  )
  expect(readJobs(app)).toHaveLength(0)
})

test('DATA-008: non-magnet non-url text → invalid message, no intake', async () => {
  server = await launchServer({ testId: 'DATA-008' })
  const app = await pairedHome('DATA-008')

  await submitOnHome(app, 'just some plain text')
  await expect(app.page.getByRole('alert')).toHaveText(
    'Enter a magnet URI or an HTTP(S) URL pointing to a .torrent file.'
  )
  expect(readJobs(app)).toHaveLength(0)
})

/* ------------------------------------------------------------------ */
/* DATA-009..010 — minimal / case-insensitive magnets accepted         */

test('DATA-009: minimal infohash-only magnet (32 hex chars) is accepted', async () => {
  server = await launchServer({ testId: 'DATA-009' })
  const app = await pairedHome('DATA-009')

  await submitOnHome(app, 'magnet:?xt=urn:btih:' + 'a'.repeat(32))
  await app.waitFor(
    'metadata/selection reached for minimal magnet',
    async () => app.page.getByText('Movie 2024', { exact: false }).first().isVisible().catch(() => false),
    { timeoutMs: 25_000 }
  )
})

test('DATA-010: uppercase HEX infohash magnet is accepted (case-insensitive)', async () => {
  server = await launchServer({ testId: 'DATA-010' })
  const app = await pairedHome('DATA-010')

  await submitOnHome(app, `magnet:?xt=urn:btih:${HEX40.toUpperCase()}`)
  await app.waitFor(
    'selection reached for uppercase HEX magnet',
    async () => app.page.getByText('Movie 2024', { exact: false }).first().isVisible().catch(() => false),
    { timeoutMs: 25_000 }
  )
})

/* ------------------------------------------------------------------ */
/* DATA-020 / DATA-030 / DATA-031                                      */

test('DATA-020: double-submit race on Continue — observed intake count recorded honestly', async () => {
  server = await launchServer({ testId: 'DATA-020' })
  const app = await pairedHome('DATA-020')

  const input = app.page.getByLabel('Torrent magnet link or URL')
  await input.waitFor({ state: 'visible', timeout: 15_000 })
  await input.fill(E2E_MAGNET)

  // Fire two synchronous submits inside one evaluation so neither sees the
  // post-render disabled state — a genuine user double-click race.
  await app.page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Continue'
    ) as HTMLButtonElement
    button.click()
    button.click()
  })

  await app.waitFor(
    'at least one intake draft created',
    async () => readJobs(app).some((j) => (j['source'] as { value?: string })?.['value'] === E2E_MAGNET),
    { timeoutMs: 15_000 }
  )

  const created = readJobs(app).filter(
    (j) => (j['source'] as { value?: string })?.['value'] === E2E_MAGNET
  )

  // OBSERVED BEHAVIOR (classified honestly): the client sends NO idempotency
  // key on intake (src/main/client-relay/service.ts createIntake), so the race
  // creates TWO independent drafts. This test documents that finding; if the
  // product later deduplicates (UI debounce or client idempotency key), the
  // count drops to 1 and this assertion should be updated to lock it in.
  expect(created).toHaveLength(2)
})

test('DATA-030: idempotency key via raw HTTP — same key replays same intake, different key creates new intake', async () => {
  server = await launchServer({ testId: 'DATA-030' })

  // Pair a raw HTTP client to obtain a bearer token.
  const gen = (await server.app.serverBridge<Record<string, unknown>>('generatePairingCode()')) as Record<
    string,
    unknown
  >
  const pairRes = await fetch(`http://${server.relayAddress}:${server.relayPort}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: gen['code'] })
  })
  const { token } = (await pairRes.json()) as { token: string }
  expect(pairRes.status).toBe(200)
  const base = `http://${server.relayAddress}:${server.relayPort}/v1/intakes`
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const body = JSON.stringify({ source: { kind: 'magnet', value: E2E_MAGNET } })

  // Same Idempotency-Key twice → same intake id (engine findByIdempotencyKey).
  const first = await fetch(base, { method: 'POST', headers: { ...auth, 'idempotency-key': 'data030-key-a' }, body })
  const second = await fetch(base, { method: 'POST', headers: { ...auth, 'idempotency-key': 'data030-key-a' }, body })
  expect(first.status).toBe(201)
  expect(second.status).toBe(201)
  const firstView = (await first.json()) as { id: string }
  const secondView = (await second.json()) as { id: string }
  expect(secondView.id).toBe(firstView.id)

  // Different key → different intake id.
  const third = await fetch(base, { method: 'POST', headers: { ...auth, 'idempotency-key': 'data030-key-b' }, body })
  expect(third.status).toBe(201)
  const thirdView = (await third.json()) as { id: string }
  expect(thirdView.id).not.toBe(firstView.id)
})

test('DATA-031: friend add with unicode/emoji name renders truthfully and removes cleanly; >64-char name rejected', async () => {
  server = await launchServer({ testId: 'DATA-031' })
  const app = await pairedHome('DATA-031')

  const base = `http://${server.relayAddress}:${server.relayPort}/v1/pair`
  const genCode = async (): Promise<string> => {
    const gen = (await server!.app.serverBridge<Record<string, unknown>>('generatePairingCode()')) as Record<
      string,
      unknown
    >
    return gen['code'] as string
  }

  // Schema boundary: name max 64 → 65 chars is rejected truthfully (400).
  const tooLong = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: await genCode(), name: 'X'.repeat(65) })
  })
  expect(tooLong.status).toBe(400)

  // Special-char name within the limit pairs fine.
  const specialName = '星の友人-🎉-Ωmega'
  const special = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: await genCode(), name: specialName })
  })
  expect(special.status).toBe(200)

  // Client A's Add-friend flow lists, adds, renders, and removes the friend.
  await app.page.getByTestId('add-friend').click()
  await expect(app.page.getByTestId('add-friend-panel')).toBeVisible()
  await expect(app.page.getByTestId('add-friend-select')).toContainText(specialName)
  await app.page.getByTestId('add-friend-confirm').click()

  const chip = app.page.getByTestId(`friend-${((await special.json()) as { clientId: string }).clientId}`)
  await expect(chip).toContainText(specialName)
  await expect(app.page.getByText(`Added ${specialName} as a friend.`)).toBeVisible()

  await app.page.getByRole('button', { name: `Remove ${specialName}` }).click()
  await expect(app.page.getByTestId('no-friends')).toBeVisible()
})
