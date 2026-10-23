/**
 * Direct-job sender status ("ping"): GET /v1/direct-jobs/sent + GET /v1/direct-jobs/:id.
 *
 * The sender checks what it sent on demand — never polled. Tenant rule: only
 * the sender or the receiver may read a job; everyone else gets a plain 404.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AuthController } from '../../src/main/auth/index.ts';
import { buildRelayServer } from '../../src/main/relay/http/app.ts';
import { DirectJobStore } from '../../src/main/server/direct-job-store.ts';
import { ClientRelayService } from '../../src/main/client-relay/service.ts';
import { FakeJobService, pairClient } from './helpers.ts';

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';

async function buildAppWithStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'vr-direct-status-'));
  const auth = new AuthController();
  const directJobs = new DirectJobStore(path.join(dir, 'direct-jobs.json'));
  const app = buildRelayServer({ auth, jobs: new FakeJobService() as never, logger: false, directJobs });
  await app.ready();
  return { app, auth };
}

describe('relay: on-demand direct-job sender status', () => {
  it('sent + :id report queued/accepted to the sender, 404 to strangers, 401 without token', async () => {
    const { app, auth } = await buildAppWithStore();
    try {
      const senderToken = await pairClient(app, auth, 'sender');
      const receiverToken = await pairClient(app, auth, 'receiver');
      const strangerToken = await pairClient(app, auth, 'stranger');
      const receiverId = auth.listClients().find((c) => c.name === 'receiver')!.clientId;

      const unauth = await app.inject({ method: 'GET', url: '/v1/direct-jobs/sent' });
      assert.equal(unauth.statusCode, 401);

      const created = await app.inject({
        method: 'POST',
        url: '/v1/direct-jobs',
        headers: { authorization: `Bearer ${senderToken}` },
        payload: { source: MAGNET, targetClientId: receiverId },
      });
      assert.equal(created.statusCode, 201);
      const jobId = (created.json() as { id: string }).id;

      // /sent: sender sees it WITHOUT the link echoed back.
      const sent = await app.inject({
        method: 'GET',
        url: '/v1/direct-jobs/sent',
        headers: { authorization: `Bearer ${senderToken}` },
      });
      assert.equal(sent.statusCode, 200);
      const jobs = (sent.json() as { jobs: Array<Record<string, unknown>> }).jobs;
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]['id'], jobId);
      assert.equal(jobs[0]['state'], 'queued');
      assert.equal(jobs[0]['targetClientId'], receiverId);
      assert.equal('source' in jobs[0], false);

      // Receiver sent nothing.
      const receiverSent = await app.inject({
        method: 'GET',
        url: '/v1/direct-jobs/sent',
        headers: { authorization: `Bearer ${receiverToken}` },
      });
      assert.equal((receiverSent.json() as { jobs: unknown[] }).jobs.length, 0);

      // Sender pings the single job: queued.
      const ping1 = await app.inject({
        method: 'GET',
        url: `/v1/direct-jobs/${jobId}`,
        headers: { authorization: `Bearer ${senderToken}` },
      });
      assert.equal(ping1.statusCode, 200);
      assert.equal((ping1.json() as { state: string }).state, 'queued');

      // Stranger gets a plain 404 — no cross-tenant oracle.
      const snooped = await app.inject({
        method: 'GET',
        url: `/v1/direct-jobs/${jobId}`,
        headers: { authorization: `Bearer ${strangerToken}` },
      });
      assert.equal(snooped.statusCode, 404);

      // Receiver accepts; sender now reads accepted.
      const accepted = await app.inject({
        method: 'POST',
        url: `/v1/direct-jobs/${jobId}/accept`,
        headers: { authorization: `Bearer ${receiverToken}` },
      });
      assert.equal(accepted.statusCode, 200);
      const ping2 = await app.inject({
        method: 'GET',
        url: `/v1/direct-jobs/${jobId}`,
        headers: { authorization: `Bearer ${senderToken}` },
      });
      assert.equal((ping2.json() as { state: string }).state, 'accepted');
      const sent2 = await app.inject({
        method: 'GET',
        url: '/v1/direct-jobs/sent',
        headers: { authorization: `Bearer ${senderToken}` },
      });
      assert.equal((sent2.json() as { jobs: Array<{ state: string }> }).jobs[0].state, 'accepted');

      // Unknown id is a clean 404.
      const missing = await app.inject({
        method: 'GET',
        url: '/v1/direct-jobs/dj_missing',
        headers: { authorization: `Bearer ${senderToken}` },
      });
      assert.equal(missing.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

describe('relay: receiver-reported download progress', () => {
  it('receiver reports % + speed, sender reads it; others get 404; bad bodies get 400', async () => {
    const { app, auth } = await buildAppWithStore();
    try {
      const senderToken = await pairClient(app, auth, 'sender');
      const receiverToken = await pairClient(app, auth, 'receiver');
      const strangerToken = await pairClient(app, auth, 'stranger');
      const receiverId = auth.listClients().find((c) => c.name === 'receiver')!.clientId;

      const created = await app.inject({
        method: 'POST',
        url: '/v1/direct-jobs',
        headers: { authorization: `Bearer ${senderToken}` },
        payload: { source: MAGNET, targetClientId: receiverId },
      });
      const jobId = (created.json() as { id: string }).id;

      // No progress before the first report.
      const before = await app.inject({
        method: 'GET',
        url: `/v1/direct-jobs/${jobId}`,
        headers: { authorization: `Bearer ${senderToken}` },
      });
      assert.equal((before.json() as { progress: unknown }).progress, null);

      // Receiver reports mid-download progress.
      const report = await app.inject({
        method: 'POST',
        url: `/v1/direct-jobs/${jobId}/report`,
        headers: { authorization: `Bearer ${receiverToken}` },
        payload: { progressPct: 42.5, dlSpeedBps: 1_245_000, downloadedBytes: 4200, totalBytes: 10_000 },
      });
      assert.equal(report.statusCode, 200);

      // Sender reads it back on both surfaces.
      const ping = await app.inject({
        method: 'GET',
        url: `/v1/direct-jobs/${jobId}`,
        headers: { authorization: `Bearer ${senderToken}` },
      });
      const progress = (ping.json() as { progress: Record<string, unknown> }).progress;
      assert.equal(progress['progressPct'], 42.5);
      assert.equal(progress['dlSpeedBps'], 1_245_000);
      assert.equal(progress['downloadedBytes'], 4200);
      assert.equal(progress['totalBytes'], 10_000);
      assert.ok(typeof progress['updatedAt'] === 'string');
      const sent = await app.inject({
        method: 'GET',
        url: '/v1/direct-jobs/sent',
        headers: { authorization: `Bearer ${senderToken}` },
      });
      assert.equal(
        (sent.json() as { jobs: Array<{ progress: Record<string, unknown> }> }).jobs[0].progress['progressPct'],
        42.5,
      );

      // Sender is not the receiver: 404, not a write.
      const senderReport = await app.inject({
        method: 'POST',
        url: `/v1/direct-jobs/${jobId}/report`,
        headers: { authorization: `Bearer ${senderToken}` },
        payload: { progressPct: 100 },
      });
      assert.equal(senderReport.statusCode, 404);

      // Stranger: 404, no oracle.
      const strangerReport = await app.inject({
        method: 'POST',
        url: `/v1/direct-jobs/${jobId}/report`,
        headers: { authorization: `Bearer ${strangerToken}` },
        payload: { progressPct: 100 },
      });
      assert.equal(strangerReport.statusCode, 404);

      // No token: 401.
      const unauth = await app.inject({
        method: 'POST',
        url: `/v1/direct-jobs/${jobId}/report`,
        payload: { progressPct: 10 },
      });
      assert.equal(unauth.statusCode, 401);

      // Out-of-range percent and unknown fields: 400.
      const badPct = await app.inject({
        method: 'POST',
        url: `/v1/direct-jobs/${jobId}/report`,
        headers: { authorization: `Bearer ${receiverToken}` },
        payload: { progressPct: 101 },
      });
      assert.equal(badPct.statusCode, 400);
      const unknownField = await app.inject({
        method: 'POST',
        url: `/v1/direct-jobs/${jobId}/report`,
        headers: { authorization: `Bearer ${receiverToken}` },
        payload: { progressPct: 50, injected: true },
      });
      assert.equal(unknownField.statusCode, 400);

      // Unknown job id: 404.
      const missing = await app.inject({
        method: 'POST',
        url: '/v1/direct-jobs/dj_missing/report',
        headers: { authorization: `Bearer ${receiverToken}` },
        payload: { progressPct: 50 },
      });
      assert.equal(missing.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

describe('client service: friend nicknames', () => {
  it('sets, trims, clears, and validates aliases without touching identity', () => {
    const settingsState: Record<string, unknown> = { friends: [] };
    const settingsFake = {
      get: (): { friends: Array<{ clientId: string; name: string; alias?: string }> } => ({
        friends: (settingsState['friends'] ?? []) as Array<{ clientId: string; name: string; alias?: string }>,
      }),
      update: (patch: Record<string, unknown>): void => {
        Object.assign(settingsState, patch);
      },
    };
    const secretsFake = {
      get: (): string | null => null,
      set: (): boolean => true,
      delete: (): boolean => true,
    };
    const svc = new ClientRelayService(settingsFake as never, secretsFake as never);

    svc.addFriend({ clientId: 'c1', name: 'paired-client' });

    const renamed = svc.renameFriend('c1', '  Best Buddy  ');
    assert.equal(renamed.ok, true);
    assert.deepEqual(svc.getFriends(), [{ clientId: 'c1', name: 'paired-client', alias: 'Best Buddy' }]);

    const cleared = svc.renameFriend('c1', '   ');
    assert.equal(cleared.ok, true);
    assert.deepEqual(svc.getFriends(), [{ clientId: 'c1', name: 'paired-client' }]);

    assert.equal(svc.renameFriend('c1', 'x'.repeat(33)).ok, false);
    assert.equal(svc.renameFriend('unknown', 'Nick').ok, false);
    // Identity untouched by the failed attempts.
    assert.deepEqual(svc.getFriends(), [{ clientId: 'c1', name: 'paired-client' }]);
  });
});
