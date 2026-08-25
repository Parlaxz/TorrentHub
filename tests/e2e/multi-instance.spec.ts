import { test, expect } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  launchServer,
  pairClient,
  E2E_MAGNET,
  E2E_QBIT_KEY,
  type ServerCluster,
  type PairedClient
} from './harness/cluster'

/**
 * MULTI lane — friends, send-to-friend, SendDirectModal, recipient inbox.
 * UI-level: real server app + REAL-UI-paired client apps (pairClient).
 * Permanent IDs; never renumber.
 *
 * DOCUMENTED DEVIATIONS (evidence, not hides):
 *
 * 1. MULTI-022 "Decline removes it": the recipient inbox keeps declined items
 *    VISIBLE with state 'declined' and no action buttons
 *    (DirectDownloadsService.decline marks local state; GlobalSettingsModal
 *    renders the whole queue). Truthful assertion: item leaves the PENDING
 *    state / loses its action buttons, and shows 'declined'.
 *
 * 2. MULTI-022 file-on-disk proof: an accepted magnet job is added to the
 *    recipient's qBittorrent. The wire-level mock writes deterministic files
 *    under savePath once /torrents/info polls exceed downloadTicks, so the
 *    spec drives those polls (same Bearer key contract) until the file lands,
 *    then asserts on the real filesystem.
 */

/* ------------------------------------------------------------------ */
/* Cluster lifecycle                                                   */

let clusters: ServerCluster[] = []
let clients: PairedClient[] = []
let tempDirs: string[] = []

test.afterEach(async () => {
  const c = clients
  clients = []
  for (const x of c) await x.close().catch(() => undefined)
  const s = clusters
  clusters = []
  for (const x of s) await x.close().catch(() => undefined)
  const d = tempDirs
  tempDirs = []
  for (const dir of d) rmSync(dir, { recursive: true, force: true })
})

async function startCluster(testId: string): Promise<ServerCluster> {
  const srv = await launchServer({ testId })
  clusters.push(srv)
  return srv
}

async function startClient(testId: string, srv: ServerCluster, label: string): Promise<PairedClient> {
  const cli = await pairClient({ testId, server: srv, label })
  clients.push(cli)
  return cli
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/* ------------------------------------------------------------------ */
/* Shared steps                                                        */

interface RosterEntry {
  clientId: string
  name: string
}

/** The OTHER paired clients as seen by this client (roster excludes self). */
async function rosterOf(cli: PairedClient): Promise<RosterEntry[]> {
  return cli.app.clientBridge<RosterEntry[]>('clientsList()')
}

/** Adds the first available roster entry as a friend through the REAL modal. */
async function addFirstFriendViaUi(cli: PairedClient): Promise<RosterEntry> {
  const roster = await rosterOf(cli)
  expect(roster.length).toBeGreaterThanOrEqual(1)
  await cli.app.page.getByTestId('add-friend').click()
  const panel = cli.app.page.getByTestId('add-friend-panel')
  await panel.waitFor({ state: 'visible', timeout: 10_000 })
  // The select defaults to roster[0]; confirm adds that friend.
  await cli.app.page.getByTestId('add-friend-confirm').click()
  await panel.waitFor({ state: 'hidden', timeout: 10_000 })
  return roster[0]
}

/* ------------------------------------------------------------------ */
/* MULTI-010..012 — friends list                                       */

test('MULTI-010: add-friend modal lists paired clients and a friend chip appears', async () => {
  const srv = await startCluster('MULTI-010')
  const a = await startClient('MULTI-010', srv, 'client-a')
  const b = await startClient('MULTI-010', srv, 'client-b')

  // A's roster contains exactly B (self excluded).
  const roster = await rosterOf(a)
  expect(roster.length).toBe(1)
  const bEntry = roster[0]

  await a.app.page.getByTestId('add-friend').click()
  const panel = a.app.page.getByTestId('add-friend-panel')
  await panel.waitFor({ state: 'visible', timeout: 10_000 })

  // The select offers the paired client.
  const select = a.app.page.getByTestId('add-friend-select')
  await select.waitFor({ state: 'visible', timeout: 5_000 })
  expect((await select.locator('option').count())).toBe(1)

  await a.app.page.getByTestId('add-friend-confirm').click()
  await panel.waitFor({ state: 'hidden', timeout: 10_000 })

  // Friend chip appears keyed by clientId and shows the friend's name.
  const chip = a.app.page.getByTestId(`friend-${bEntry.clientId}`)
  await chip.waitFor({ state: 'visible', timeout: 10_000 })
  expect(await chip.innerText()).toContain(bEntry.name)
  await a.app.screenshot('multi-010-friend-added')
})

test('MULTI-011: removing a friend makes the chip disappear', async () => {
  const srv = await startCluster('MULTI-011')
  const a = await startClient('MULTI-011', srv, 'client-a')
  await startClient('MULTI-011', srv, 'client-b')
  const bEntry = await addFirstFriendViaUi(a)

  const chip = a.app.page.getByTestId(`friend-${bEntry.clientId}`)
  await chip.waitFor({ state: 'visible', timeout: 10_000 })

  // Remove via the chip's labelled remove button.
  await a.app.page.getByLabel(`Remove ${bEntry.name}`).click()
  await chip.waitFor({ state: 'detached', timeout: 10_000 })
  await a.app.screenshot('multi-011-friend-removed')
})

test('MULTI-012: empty states - no-friends text before adding; empty roster message in the modal', async () => {
  const srv = await startCluster('MULTI-012')
  const only = await startClient('MULTI-012', srv, 'client-only')

  // Before any friend: truthful empty-state copy.
  const noFriends = only.app.page.getByTestId('no-friends')
  await noFriends.waitFor({ state: 'visible', timeout: 10_000 })
  expect(await noFriends.innerText()).toContain('No friends yet')

  // With NO other paired clients, the add-friend modal says so truthfully.
  await only.app.page.getByTestId('add-friend').click()
  const panel = only.app.page.getByTestId('add-friend-panel')
  await panel.waitFor({ state: 'visible', timeout: 10_000 })
  await only.app.waitFor('empty-roster message visible', async () => {
    return (await panel.getByText('No other paired clients found on the server.').count()) > 0
  })
  await only.app.screenshot('multi-012-empty-states')
})

/* ------------------------------------------------------------------ */
/* MULTI-013..015 — send-to-friend panel                               */

test('MULTI-013: valid source sent to a friend shows Sent feedback and lands on the server queue', async () => {
  const srv = await startCluster('MULTI-013')
  const a = await startClient('MULTI-013', srv, 'client-a')
  await startClient('MULTI-013', srv, 'client-b')
  const bEntry = await addFirstFriendViaUi(a)

  const input = a.app.page.getByTestId('friend-link-input')
  await input.waitFor({ state: 'visible', timeout: 10_000 })
  await input.fill(E2E_MAGNET)
  await a.app.page.getByTestId('send-to-friend').click()

  // "Sent ✓" feedback (escaped to keep this file pure ASCII).
  await a.app.waitFor('Sent feedback visible', async () => {
    return (await a.app.page.getByText('Sent \u2713').count()) > 0
  })
  await a.app.screenshot('multi-013-sent-feedback')

  // Cross-layer truth: the direct job really reached the server queue.
  await srv.app.waitFor('direct job recorded server-side', async () => {
    const jobs = (await srv.app.serverBridge<Array<Record<string, unknown>>>('listDirectJobs()')) as Array<
      Record<string, unknown>
    >
    return jobs.some((j) => j['source'] === E2E_MAGNET && j['targetClientId'] === bEntry.clientId)
  })
})

test('MULTI-014: invalid source shows an inline error instead of sending', async () => {
  const srv = await startCluster('MULTI-014')
  const a = await startClient('MULTI-014', srv, 'client-a')
  await startClient('MULTI-014', srv, 'client-b')
  await addFirstFriendViaUi(a)

  const input = a.app.page.getByTestId('friend-link-input')
  await input.waitFor({ state: 'visible', timeout: 10_000 })
  await input.fill('not-a-magnet-or-url')
  await a.app.page.getByTestId('send-to-friend').click()

  // Inline validation error (HomeScreen.validateIntakeInput copy).
  await a.app.waitFor('inline validation error visible', async () => {
    return (
      (await a.app.page.getByText('Enter a magnet URI or an HTTP(S) URL pointing to a .torrent file.').count()) > 0
    )
  })
  // Nothing was sent.
  const jobs = (await srv.app.serverBridge<Array<Record<string, unknown>>>('listDirectJobs()')) as Array<
    Record<string, unknown>
  >
  expect(jobs.length).toBe(0)
  await a.app.screenshot('multi-014-inline-error')
})

test('MULTI-015: stale target (revoked friend) surfaces a truthful error', async () => {
  const srv = await startCluster('MULTI-015')
  const a = await startClient('MULTI-015', srv, 'client-a')
  await startClient('MULTI-015', srv, 'client-b')
  const bEntry = await addFirstFriendViaUi(a)

  // Revoke B server-side (same IPC the SettingsPanel revoke uses).
  const removed = (await srv.app.serverBridge<Record<string, unknown>>(
    `revokePairedClient(${JSON.stringify(bEntry.clientId)})`
  )) as Record<string, unknown>
  expect(removed['removed']).toBe(true)

  const input = a.app.page.getByTestId('friend-link-input')
  await input.waitFor({ state: 'visible', timeout: 10_000 })
  await input.fill(E2E_MAGNET)
  await a.app.page.getByTestId('send-to-friend').click()

  // The relay answers 404 "target client is not paired"; the humanized error
  // carries the server message into the inline error slot.
  await a.app.waitFor('truthful stale-target error visible', async () => {
    return (await a.app.page.getByText(/target client is not paired/i).count()) > 0
  }, { timeoutMs: 20_000 })
  await a.app.screenshot('multi-015-stale-target-error')
})

/* ------------------------------------------------------------------ */
/* MULTI-020..021 — server SendDirectModal                             */

test('MULTI-020: SendDirectModal targets paired clients and a valid magnet lands in sent-list', async () => {
  const srv = await startCluster('MULTI-020')
  const b = await startClient('MULTI-020', srv, 'client-b')

  await srv.app.page.getByTestId('send-to-friend').click()
  const targetSelect = srv.app.page.getByTestId('send-target')
  await targetSelect.waitFor({ state: 'visible', timeout: 10_000 })
  // Populated with the paired client(s).
  const options = targetSelect.locator('option')
  expect(await options.count()).toBeGreaterThanOrEqual(1)

  await srv.app.page.getByLabel('Magnet or link').fill(E2E_MAGNET)
  await srv.app.page.getByTestId('send-direct').click()

  // sent-list entry appears with the source and the queued state label.
  const sentList = srv.app.page.getByTestId('sent-list')
  await sentList.waitFor({ state: 'visible', timeout: 10_000 })
  await srv.app.waitFor('sent-list shows the magnet queued for the friend', async () => {
    const text = await sentList.innerText().catch(() => '')
    return text.includes(E2E_MAGNET) && text.includes('Queued on friend')
  })
  void b
  await srv.app.screenshot('multi-020-sent-list')
})

test('MULTI-021: SendDirectModal disables Send while the source is empty', async () => {
  const srv = await startCluster('MULTI-021')
  await startClient('MULTI-021', srv, 'client-b')

  await srv.app.page.getByTestId('send-to-friend').click()
  const sendBtn = srv.app.page.getByTestId('send-direct')
  await sendBtn.waitFor({ state: 'visible', timeout: 10_000 })
  expect(await sendBtn.isEnabled()).toBe(false)

  // Typing enables it; clearing disables it again.
  const source = srv.app.page.getByLabel('Magnet or link')
  await source.fill(E2E_MAGNET)
  expect(await sendBtn.isEnabled()).toBe(true)
  await source.fill('')
  expect(await sendBtn.isEnabled()).toBe(false)
  await srv.app.screenshot('multi-021-disabled-send')
})

/* ------------------------------------------------------------------ */
/* MULTI-022 — recipient inbox: decline + accept downloads for real    */

test('MULTI-022: recipient inbox queues, declines, and accepting downloads the file to the configured folder', async () => {
  test.slow()
  const srv = await startCluster('MULTI-022')
  const recip = await startClient('MULTI-022', srv, 'recipient')
  const page = recip.app.page

  // ---- configure receiver settings through the global settings UI ----
  const downloadDir = makeTempDir('vr-dd-out-')
  await page.getByTestId('global-settings-button').click()
  const section = page.getByTestId('direct-downloads-section')
  await section.waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByTestId('dd-qbit-url').fill(srv.qbit.url)
  await page.getByTestId('dd-qbit-key').fill(E2E_QBIT_KEY)
  await page.getByTestId('dd-download-dir').fill(downloadDir)
  await page.getByTestId('dd-save').click()
  // Saved truthfully: the key placeholder flips once the secret is stored.
  await recip.app.waitFor('receiver settings saved', async () => {
    const placeholder = await page.getByTestId('dd-qbit-key').getAttribute('placeholder')
    return placeholder === 'API key saved \u2713'
  })
  await page.keyboard.press('Escape') // close settings

  // ---- server sends a magnet to the recipient over the real bridge ----
  const paired = (await srv.app.serverBridge<Array<{ clientId: string; name: string }>>(
    'listPairedClients()'
  )) as Array<{ clientId: string; name: string }>
  expect(paired.length).toBe(1)
  const targetClientId = paired[0].clientId

  const sendViaBridge = async (): Promise<string> => {
    const res = (await srv.app.serverBridge<Record<string, unknown>>(
      `sendDirectJob(${JSON.stringify(E2E_MAGNET)}, ${JSON.stringify(targetClientId)})`
    )) as Record<string, unknown>
    expect(res['ok']).toBe(true)
    return res['id'] as string
  }

  const openInboxAndRefresh = async (): Promise<void> => {
    // The modal may already be open (its backdrop intercepts the header button).
    if ((await page.getByTestId('global-settings-modal').count()) === 0) {
      await page.getByTestId('global-settings-button').click()
      await section.waitFor({ state: 'visible', timeout: 10_000 })
    }
    await page.getByTestId('dd-refresh').click() // forces pollOnce (else 5s timer)
  }

  // ---- DECLINE: item leaves pending, buttons gone, state shown truthfully ----
  const declineId = await sendViaBridge()
  await openInboxAndRefresh()
  await recip.app.waitFor(
    `queued direct job ${declineId} appears in inbox`,
    async () => (await page.getByTestId(`dd-item-${declineId}`).count()) > 0,
    { timeoutMs: 15_000 }
  )
  await page.getByTestId(`dd-decline-${declineId}`).click()
  // NOTE (deviation 1): declined items stay listed with state 'declined'.
  await recip.app.waitFor('item shows declined state', async () => {
    const text = await page.getByTestId(`dd-item-${declineId}`).innerText().catch(() => '')
    return text.includes('declined')
  })
  expect(await page.getByTestId(`dd-decline-${declineId}`).count()).toBe(0)
  await recip.app.screenshot('multi-022-declined')

  // ---- ACCEPT: pending -> done, torrent added, FILE LANDS on disk ----
  const acceptId = await sendViaBridge()
  await openInboxAndRefresh()
  await recip.app.waitFor(
    `queued direct job ${acceptId} appears in inbox`,
    async () => (await page.getByTestId(`dd-item-${acceptId}`).count()) > 0,
    { timeoutMs: 15_000 }
  )
  await page.getByTestId(`dd-accept-${acceptId}`).click()
  await recip.app.waitFor('accepted item reaches done', async () => {
    const text = await page.getByTestId(`dd-item-${acceptId}`).innerText().catch(() => '')
    return text.includes('done')
  }, { timeoutMs: 30_000 })

  // The recipient's qBittorrent REALLY received the add call.
  const adds = srv.qbit.requests.filter((r) => r.path === '/api/v2/torrents/add')
  expect(adds.length).toBeGreaterThanOrEqual(1)

  // Drive the mock's completion polls (Bearer-key contract), then the mock
  // writes deterministic files under the configured savePath.
  const movieFile = join(downloadDir, 'Movie', 'movie.mkv')
  await expect
    .poll(
      async () => {
        try {
          await fetch(`${srv.qbit.url}/api/v2/torrents/info`, {
            headers: { Authorization: `Bearer ${E2E_QBIT_KEY}` }
          })
        } catch {
          /* transient */
        }
        return existsSync(movieFile)
      },
      { timeout: 20_000, intervals: [400] }
    )
    .toBe(true)
  expect(existsSync(movieFile)).toBe(true)
  await recip.app.screenshot('multi-022-accepted-file-landed')
})
