import { test, expect } from '@playwright/test'
import { launchServer, type ServerCluster } from './harness/cluster'

/**
 * INT lane — real HTTP contract against the LIVE relay inside a running
 * server app (T2). Raw node fetch against http://<relayAddress>:<relayPort>.
 * Permanent IDs; never renumber.
 *
 * DOCUMENTED DEVIATIONS / CONTRACT NOTES (evidence, not hides):
 *
 * 1. POST /v1/intakes responds 201 with an IntakeDraftView {id,state,metadata,
 *    error} (src/main/relay/http/routes.ts -> EngineJobService.createIntake),
 *    NOT the documented IntakeAcceptedSchema {intakeId} from
 *    src/shared/api.ts. Specs assert the truthful wire shape (body.id).
 *
 * 2. POST /v1/jobs COMMITS the selection and starts the transfer atomically
 *    (engine.commitSelection sets state='queued' before returning), so the
 *    201 snapshot is an early transfer state ('queued' or already
 *    'downloading' - serialization races the async pipeline start), never
 *    'awaiting_selection' as the plan text assumed. Asserted truthfully;
 *    pipeline completion verified.
 *
 * 3. Empty selection ([]): src/shared/api.ts documents min(1) (would be 400),
 *    but the canonical relay schema (src/main/relay/http/schemas.ts
 *    jobCreateSchema) has NO min(1), so [] passes zod and the engine rejects
 *    it with InvalidTransitionError -> currently an HTTP 500 internal_error
 *    (untranslated engine error - suspected defect, see INT-013).
 *
 * 4. Pairing codes: TTL is 10 minutes (unreachable in E2E budget), so the
 *    expired-code 410 branch is exercised indirectly: pairing codes live ONLY
 *    in memory (PairingService.pending), so stopping/restarting the server
 *    invalidates them -> truthful 400 invalid_code.
 */

/* ------------------------------------------------------------------ */
/* Cluster lifecycle                                                   */

let clusters: ServerCluster[] = []

test.afterEach(async () => {
  const open = clusters
  clusters = []
  for (const s of open) await s.close().catch(() => undefined)
})

async function startCluster(testId: string, label?: string): Promise<ServerCluster> {
  const srv = await launchServer({ testId, label })
  clusters.push(srv)
  return srv
}

/* ------------------------------------------------------------------ */
/* Raw HTTP helpers                                                    */

interface ApiResponse {
  status: number
  contentType: string
  wwwAuthenticate: string | null
  retryAfter: string | null
  json: Record<string, unknown> | null
}

async function api(
  srv: ServerCluster,
  method: 'GET' | 'POST',
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<ApiResponse> {
  const headers: Record<string, string> = {}
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`http://${srv.relayAddress}:${srv.relayPort}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  })
  let json: Record<string, unknown> | null = null
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    json = null
  }
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    wwwAuthenticate: res.headers.get('www-authenticate'),
    retryAfter: res.headers.get('retry-after'),
    json
  }
}

interface RawClient {
  clientId: string
  name: string
  token: string
}

/** Generates a REAL pairing code through the server bridge, then pairs over raw HTTP. */
async function rawPair(srv: ServerCluster, name?: string): Promise<RawClient> {
  const info = (await srv.app.serverBridge<Record<string, unknown>>('generatePairingCode()')) as Record<string, unknown>
  const code = info['code']
  if (typeof code !== 'string') throw new Error(`no code in ${JSON.stringify(info)}`)
  const res = await api(srv, 'POST', '/v1/pair', { body: { code, ...(name ? { name } : {}) } })
  expect(res.status).toBe(200)
  return res.json as unknown as RawClient
}

const E2E_MAGNET =
  'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Movie%202024&tr=http://tracker.e2e/announce'

/* ------------------------------------------------------------------ */
/* INT-001..005 — health / pairing / auth guard                        */

test('INT-001: GET /v1/health answers {ok:true} with no auth', async () => {
  const srv = await startCluster('INT-001')
  const res = await api(srv, 'GET', '/v1/health')
  expect(res.status).toBe(200)
  expect(res.contentType).toContain('application/json')
  expect(res.json).toEqual({ ok: true })
})

test('INT-002: POST /v1/pair happy path issues credentials and persists the name in the roster', async () => {
  const srv = await startCluster('INT-002')
  const info = (await srv.app.serverBridge<Record<string, unknown>>('generatePairingCode()')) as Record<string, unknown>
  const code = info['code']
  expect(typeof code).toBe('string')

  const res = await api(srv, 'POST', '/v1/pair', { body: { code, name: 'e2e-named-client' } })
  expect(res.status).toBe(200)
  const body = res.json as Record<string, unknown>
  expect(typeof body['clientId']).toBe('string')
  expect((body['clientId'] as string).length).toBeGreaterThan(0)
  expect(body['name']).toBe('e2e-named-client')
  expect(typeof body['token']).toBe('string')
  expect((body['token'] as string).length).toBeGreaterThan(0)

  // Name persisted in the roster: a SECOND paired client sees it via /v1/clients.
  const probe = await rawPair(srv, 'roster-probe')
  const roster = await api(srv, 'GET', '/v1/clients', { token: probe.token })
  expect(roster.status).toBe(200)
  const clients = (roster.json as Record<string, unknown>)['clients'] as Array<Record<string, unknown>>
  const named = clients.find((c) => c['clientId'] === body['clientId'])
  expect(named).toBeDefined()
  expect(named!['name']).toBe('e2e-named-client')
})

test('INT-003: every bearer route without a token answers 401 + WWW-Authenticate: Bearer + unauthorized envelope', async () => {
  const srv = await startCluster('INT-003')
  // Only routes that EXIST (routes.ts registers no GET /v1/intakes list route).
  const cases: Array<{ method: 'GET' | 'POST'; path: string; body?: unknown }> = [
    { method: 'POST', path: '/v1/intakes', body: {} },
    { method: 'GET', path: '/v1/jobs' },
    { method: 'POST', path: '/v1/jobs', body: {} },
    { method: 'GET', path: '/v1/history' },
    { method: 'GET', path: '/v1/server/status' },
    { method: 'GET', path: '/v1/clients' },
    { method: 'GET', path: '/v1/direct-jobs' },
    { method: 'POST', path: '/v1/direct-jobs', body: {} }
  ]
  for (const c of cases) {
    const res = await api(srv, c.method, c.path, c.body === undefined ? {} : { body: c.body })
    expect(res.status, `${c.method} ${c.path}`).toBe(401)
    expect(res.wwwAuthenticate, `${c.method} ${c.path}`).toBe('Bearer')
    expect(res.json, `${c.method} ${c.path}`).toEqual({ error: 'unauthorized' })
  }
  // Documented non-route: there is no intake LIST endpoint - plain 404 envelope.
  const noListRoute = await api(srv, 'GET', '/v1/intakes')
  expect(noListRoute.status).toBe(404)
  expect(noListRoute.json).toEqual({ error: 'not_found' })
})

test('INT-004: pair schema violations (short / long / forbidden characters) answer 400 validation_error', async () => {
  const srv = await startCluster('INT-004')
  // Alphabet excludes I/L/O/0/1; length must be 6..10 AFTER dash/space stripping.
  const badCodes = ['AB2', 'ABCDEFGHJKM', 'AI23456']
  for (const code of badCodes) {
    const res = await api(srv, 'POST', '/v1/pair', { body: { code } })
    expect(res.status, `code=${code}`).toBe(400)
    expect(res.json!['error'], `code=${code}`).toBe('validation_error')
    expect(Array.isArray(res.json!['issues']), `code=${code}`).toBe(true)
  }
})

test('INT-005: pairing codes do not survive a server restart (in-memory store) - old code rejected truthfully', async () => {
  // TTL is 10 minutes (pairing.ts DEFAULT_PAIRING_TTL_MS) - un-waitable in E2E.
  // Truthful reachable proof: codes live only in PairingService.pending (RAM);
  // stop the server, start a fresh one, and the old code is no longer pending.
  const first = await startCluster('INT-005', 'int5-before')
  const info = (await first.app.serverBridge<Record<string, unknown>>('generatePairingCode()')) as Record<string, unknown>
  const code = info['code'] as string

  // STOP the server (closes app + mocks) and start a fresh instance.
  const idx = clusters.indexOf(first)
  clusters.splice(idx, 1)
  await first.close()
  const restarted = await startCluster('INT-005', 'int5-after')

  const res = await api(restarted, 'POST', '/v1/pair', { body: { code } })
  expect(res.status).toBe(400)
  expect(res.json!['error']).toBe('invalid_code')
})

/* ------------------------------------------------------------------ */
/* INT-010..014 — intakes + jobs                                       */

test('INT-010: POST /v1/intakes (magnet) creates a draft and GET resolves it with mock metadata', async () => {
  const srv = await startCluster('INT-010')
  const client = await rawPair(srv)

  const created = await api(srv, 'POST', '/v1/intakes', {
    token: client.token,
    body: { source: { kind: 'magnet', value: E2E_MAGNET } }
  })
  expect(created.status).toBe(201)
  // NOTE (deviation 1): wire shape is IntakeDraftView {id,...}, not {intakeId}.
  const draft = created.json as Record<string, unknown>
  expect(typeof draft['id']).toBe('string')

  const fetched = await api(srv, 'GET', `/v1/intakes/${draft['id'] as string}`, { token: client.token })
  expect(fetched.status).toBe(200)
  const view = fetched.json as Record<string, unknown>
  expect(view['id']).toBe(draft['id'])
  expect(view['state']).toBe('awaiting_selection')
  const metadata = view['metadata'] as Record<string, unknown>
  expect(metadata['name']).toBe('Movie 2024')
  expect((metadata['files'] as unknown[]).length).toBe(3)
})

test('INT-011: intake source validation rejects short magnets, oversize values, non-magnets and non-http URLs', async () => {
  const srv = await startCluster('INT-011')
  const client = await rawPair(srv)
  const badBodies: Array<Record<string, unknown>> = [
    { source: { kind: 'magnet', value: 'magnet:' } }, // < 8 chars
    { source: { kind: 'magnet', value: `magnet:?xt=urn:btih:${'a'.repeat(5000)}` } }, // > 4096
    { source: { kind: 'magnet', value: 'this is not a magnet uri' } },
    { source: { kind: 'url', value: 'ftp://example.com/file.torrent' } } // not http(s)
  ]
  for (const body of badBodies) {
    const res = await api(srv, 'POST', '/v1/intakes', { token: client.token, body })
    expect(res.status, `body=${JSON.stringify(body).slice(0, 60)}`).toBe(400)
    expect(res.json!['error']).toBe('validation_error')
  }
})

test('INT-012: POST /v1/jobs commits the selection, starts the transfer and completes against the mock', async () => {
  test.slow()
  const srv = await startCluster('INT-012')
  const client = await rawPair(srv)

  const created = await api(srv, 'POST', '/v1/intakes', {
    token: client.token,
    body: { source: { kind: 'magnet', value: E2E_MAGNET } }
  })
  const intakeId = (created.json as Record<string, unknown>)['id'] as string

  // NOTE (deviation 2): commit starts the transfer; snapshot state is 'queued'.
  const jobRes = await api(srv, 'POST', '/v1/jobs', {
    token: client.token,
    body: { intakeId, selection: [0, 1, 2] }
  })
  expect(jobRes.status).toBe(201)
  const snap = jobRes.json as Record<string, unknown>
  expect(snap['id']).toBe(intakeId) // intake id IS the job id
  // NOTE (deviation 2): commit starts the transfer; the wire snapshot is
  // captured while the pipeline spins up, so state is 'queued' or already
  // 'downloading' (serialization races the async start - observed both).
  expect(['queued', 'downloading']).toContain(snap['state'])
  expect(snap['selection']).toEqual([0, 1, 2])

  // The committed transfer really runs to completion against the mock qbit/viking.
  await expect
    .poll(
      async () => {
        const res = await api(srv, 'GET', `/v1/jobs/${intakeId}`, { token: client.token })
        return ((res.json as Record<string, unknown>) ?? {})['state']
      },
      { timeout: 45_000, intervals: [500, 1_000] }
    )
    .toBe('complete')
})

test('INT-013: selection bounds - index >1e6 and >10k indexes are 400; empty selection hits untranslated engine error (500, defect)', async () => {
  const srv = await startCluster('INT-013')
  const client = await rawPair(srv)
  const created = await api(srv, 'POST', '/v1/intakes', {
    token: client.token,
    body: { source: { kind: 'magnet', value: E2E_MAGNET } }
  })
  const intakeId = (created.json as Record<string, unknown>)['id'] as string

  // Index above the schema ceiling -> 400 validation_error.
  const tooBigIndex = await api(srv, 'POST', '/v1/jobs', {
    token: client.token,
    body: { intakeId, selection: [1_000_001] }
  })
  expect(tooBigIndex.status).toBe(400)
  expect(tooBigIndex.json!['error']).toBe('validation_error')

  // More than 10k indexes -> 400 validation_error.
  const tooMany = await api(srv, 'POST', '/v1/jobs', {
    token: client.token,
    body: { intakeId, selection: new Array<number>(10_001).fill(0) }
  })
  expect(tooMany.status).toBe(400)
  expect(tooMany.json!['error']).toBe('validation_error')

  // Empty selection -> passes relay schema (NOTE deviation 3), engine rejects
  // Empty selection: DEF-012 fixed — the relay schema now enforces the
  // documented min(1) (shared/api.ts), so [] is rejected as a 400
  // validation_error before reaching the engine.
  const empty = await api(srv, 'POST', '/v1/jobs', {
    token: client.token,
    body: { intakeId, selection: [] }
  })
  expect(empty.status).toBe(400)
  expect(empty.json!['error']).toBe('validation_error')

  // No transfer was started by the rejected attempts: draft still awaiting_selection.
  const draft = await api(srv, 'GET', `/v1/intakes/${intakeId}`, { token: client.token })
  expect(draft.status).toBe(200)
  expect((draft.json as Record<string, unknown>)['state']).toBe('awaiting_selection')
})

test('INT-014: intake idempotency - same key replays the same draft, different keys create new drafts', async () => {
  const srv = await startCluster('INT-014')
  const client = await rawPair(srv)
  const body = { source: { kind: 'magnet', value: E2E_MAGNET }, idempotencyKey: 'intake-key-1' }

  const first = await api(srv, 'POST', '/v1/intakes', { token: client.token, body })
  expect(first.status).toBe(201)
  const second = await api(srv, 'POST', '/v1/intakes', { token: client.token, body })
  expect(second.status).toBe(201)
  const id1 = (first.json as Record<string, unknown>)['id']
  const id2 = (second.json as Record<string, unknown>)['id']
  expect(id1).toBeTruthy()
  expect(id2).toBe(id1) // same key -> SAME intake

  const other = await api(srv, 'POST', '/v1/intakes', {
    token: client.token,
    body: { source: { kind: 'magnet', value: E2E_MAGNET }, idempotencyKey: 'intake-key-2' }
  })
  expect(other.status).toBe(201)
  const id3 = (other.json as Record<string, unknown>)['id']
  expect(id3).not.toBe(id1) // different key -> DIFFERENT intake
})

/* ------------------------------------------------------------------ */
/* INT-020..022 — history / server status / roster                     */

test('INT-020: history limit bounds enforced and only terminal jobs listed', async () => {
  const srv = await startCluster('INT-020')
  const client = await rawPair(srv)

  // Limit bounds: 0 rejected, 501 rejected, 500 accepted.
  const zero = await api(srv, 'GET', '/v1/history?limit=0', { token: client.token })
  expect(zero.status).toBe(400)
  expect(zero.json!['error']).toBe('validation_error')
  const over = await api(srv, 'GET', '/v1/history?limit=501', { token: client.token })
  expect(over.status).toBe(400)
  expect(over.json!['error']).toBe('validation_error')
  const max = await api(srv, 'GET', '/v1/history?limit=500', { token: client.token })
  expect(max.status).toBe(200)
  expect(Array.isArray((max.json as Record<string, unknown>)['history'])).toBe(true)

  // Terminal-only: cancel one draft (terminal 'cancelled'), leave one awaiting_selection.
  const makeIntake = async (): Promise<string> => {
    const r = await api(srv, 'POST', '/v1/intakes', {
      token: client.token,
      body: { source: { kind: 'magnet', value: E2E_MAGNET } }
    })
    expect(r.status).toBe(201)
    return (r.json as Record<string, unknown>)['id'] as string
  }
  const cancelledId = await makeIntake()
  const cancelRes = await api(srv, 'POST', `/v1/jobs/${cancelledId}/cancel`, { token: client.token })
  expect(cancelRes.status).toBe(200)
  const liveId = await makeIntake()

  const history = await api(srv, 'GET', '/v1/history?limit=50', { token: client.token })
  expect(history.status).toBe(200)
  const entries = (history.json as Record<string, unknown>)['history'] as Array<Record<string, unknown>>
  const ids = entries.map((e) => e['id'])
  expect(ids).toContain(cancelledId)
  expect(ids).not.toContain(liveId) // non-terminal drafts never appear
  const cancelledEntry = entries.find((e) => e['id'] === cancelledId)
  expect(cancelledEntry!['state']).toBe('cancelled')
})

test('INT-021: GET /v1/server/status authenticated reports ok + server identity', async () => {
  const srv = await startCluster('INT-021')
  const client = await rawPair(srv)
  const res = await api(srv, 'GET', '/v1/server/status', { token: client.token })
  expect(res.status).toBe(200)
  const body = res.json as Record<string, unknown>
  expect(body['ok']).toBe(true)
  const server = body['server'] as Record<string, unknown>
  expect(server['name']).toBe('viking-relay')
  expect(typeof server['version']).toBe('string')
  expect((server['version'] as string).length).toBeGreaterThan(0)
  expect(body['pairedClients']).toBeGreaterThanOrEqual(1)
  expect(typeof body['time']).toBe('string')
})

test('INT-022: GET /v1/clients roster excludes the calling client itself', async () => {
  const srv = await startCluster('INT-022')
  const a = await rawPair(srv, 'client-a')
  const b = await rawPair(srv, 'client-b')

  const asA = await api(srv, 'GET', '/v1/clients', { token: a.token })
  expect(asA.status).toBe(200)
  const rosterA = (asA.json as Record<string, unknown>)['clients'] as Array<Record<string, unknown>>
  expect(rosterA.map((c) => c['clientId'])).toEqual([b.clientId])
  expect(rosterA.map((c) => c['name'])).toEqual(['client-b'])

  const asB = await api(srv, 'GET', '/v1/clients', { token: b.token })
  const rosterB = (asB.json as Record<string, unknown>)['clients'] as Array<Record<string, unknown>>
  expect(rosterB.map((c) => c['clientId'])).toEqual([a.clientId])
})

/* ------------------------------------------------------------------ */
/* INT-023..024 — direct jobs queue + transitions                      */

test('INT-023: direct-job lands queued for the target client only, with self/unknown target guards', async () => {
  const srv = await startCluster('INT-023')
  const sender = await rawPair(srv, 'sender')
  const receiver = await rawPair(srv, 'receiver')

  // Self-target is rejected.
  const self = await api(srv, 'POST', '/v1/direct-jobs', {
    token: sender.token,
    body: { source: E2E_MAGNET, targetClientId: sender.clientId }
  })
  expect(self.status).toBe(400)
  expect(self.json!['error']).toBe('validation_error')

  // Unknown target is rejected.
  const unknown = await api(srv, 'POST', '/v1/direct-jobs', {
    token: sender.token,
    body: { source: E2E_MAGNET, targetClientId: 'no-such-client' }
  })
  expect(unknown.status).toBe(404)
  expect(unknown.json!['error']).toBe('not_found')

  // Happy path: sender -> receiver.
  const created = await api(srv, 'POST', '/v1/direct-jobs', {
    token: sender.token,
    body: { source: E2E_MAGNET, targetClientId: receiver.clientId }
  })
  expect(created.status).toBe(201)
  const jobId = (created.json as Record<string, unknown>)['id'] as string
  expect(jobId).toBeTruthy()

  // Receiver's queue lists it; sender's own queue does not.
  const inbox = await api(srv, 'GET', '/v1/direct-jobs', { token: receiver.token })
  expect(inbox.status).toBe(200)
  const jobs = (inbox.json as Record<string, unknown>)['jobs'] as Array<Record<string, unknown>>
  expect(jobs.length).toBe(1)
  expect(jobs[0]['id']).toBe(jobId)
  expect(jobs[0]['source']).toBe(E2E_MAGNET)
  expect(jobs[0]['sourceKind']).toBe('magnet')

  const senderInbox = await api(srv, 'GET', '/v1/direct-jobs', { token: sender.token })
  expect(((senderInbox.json as Record<string, unknown>)['jobs'] as unknown[]).length).toBe(0)
})

test('INT-024: direct-job accept/decline transitions drain the queue and reject replays', async () => {
  const srv = await startCluster('INT-024')
  const sender = await rawPair(srv, 'sender')
  const receiver = await rawPair(srv, 'receiver')

  const send = async (): Promise<string> => {
    const r = await api(srv, 'POST', '/v1/direct-jobs', {
      token: sender.token,
      body: { source: E2E_MAGNET, targetClientId: receiver.clientId }
    })
    expect(r.status).toBe(201)
    return (r.json as Record<string, unknown>)['id'] as string
  }

  // ACCEPT flow.
  const acceptId = await send()
  const accept = await api(srv, 'POST', `/v1/direct-jobs/${acceptId}/accept`, { token: receiver.token })
  expect(accept.status).toBe(200)
  expect(accept.json).toEqual({ ok: true })
  // Drained from the queued list...
  const afterAccept = await api(srv, 'GET', '/v1/direct-jobs', { token: receiver.token })
  expect(((afterAccept.json as Record<string, unknown>)['jobs'] as unknown[]).length).toBe(0)
  // ...and replaying the transition is a truthful 404 (only queued jobs transition).
  const replayAccept = await api(srv, 'POST', `/v1/direct-jobs/${acceptId}/accept`, { token: receiver.token })
  expect(replayAccept.status).toBe(404)

  // DECLINE flow.
  const declineId = await send()
  const decline = await api(srv, 'POST', `/v1/direct-jobs/${declineId}/decline`, { token: receiver.token })
  expect(decline.status).toBe(200)
  expect(decline.json).toEqual({ ok: true })
  const afterDecline = await api(srv, 'GET', '/v1/direct-jobs', { token: receiver.token })
  expect(((afterDecline.json as Record<string, unknown>)['jobs'] as unknown[]).length).toBe(0)
  const replayDecline = await api(srv, 'POST', `/v1/direct-jobs/${declineId}/decline`, { token: receiver.token })
  expect(replayDecline.status).toBe(404)

  // Unknown job id -> 404.
  const missing = await api(srv, 'POST', '/v1/direct-jobs/dj_missing/accept', { token: receiver.token })
  expect(missing.status).toBe(404)
})
