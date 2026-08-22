/**
 * Integration: Client bridge (scenario 8).
 *
 * Renderer-facing calls → ClientRelayService (main) → REAL Fastify relay
 * (buildRelayServer + EngineJobService over a real JobEngine with fake
 * gateways) on an ephemeral loopback port. The bearer token never leaves the
 * service; pairing, intake, selection+preflight and job polling all flow
 * through the canonical /v1 REST API.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { AuthController } from '../../src/main/auth/index.ts';
import { buildRelayServer } from '../../src/main/relay/http/app.ts';
import { JobEngine, resolveConfig } from '../../src/main/jobs/index.ts';
import type { JobEngineDeps } from '../../src/main/jobs/index.ts';
import {
  FakePackagingGateway,
  FakeStorageGateway,
  FakeTorrentGateway,
  FakeVikingGateway,
  FakeWorkspaceGateway,
    FakeDirectDownloadGateway,
  MemoryJobRepository,
  fakeMetadata,
} from '../jobs/fakes.ts';
import { EngineJobService } from '../../src/main/integration/job-service.ts';
import { ClientRelayService } from '../../src/main/client-relay/service.ts';

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';

class MemorySecretStore {
  readonly entries = new Map<string, string>();
  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  set(key: string, value: string): boolean {
    this.entries.set(key, value);
    return true;
  }
  delete(key: string): boolean {
    return this.entries.delete(key);
  }
}

describe('integration: client bridge over a real relay', () => {
  it('pairs, intakes, confirms selection with preflight, and tracks the job', async () => {
    // ---- server side: real engine + real relay on an ephemeral port ----
    const torrent = new FakeTorrentGateway(fakeMetadata(2, 1000), [
      { downloadedBytes: 500, selectedComplete: false },
      { downloadedBytes: 2000, selectedComplete: true },
    ]);
    const deps: JobEngineDeps = {
      torrent,
      viking: new FakeVikingGateway([{ url: 'https://viking.example/f/xyz', sha256: 'q' }]),
      packaging: new FakePackagingGateway([{ sizeBytes: 2100 }]),
      storage: new FakeStorageGateway([Number.MAX_SAFE_INTEGER]),
      workspace: new FakeWorkspaceGateway(),
      direct: new FakeDirectDownloadGateway(),
      repository: new MemoryJobRepository(),
    };
    const root = await mkdtemp(path.join(tmpdir(), 'vr-clientbridge-'));
    const engine = new JobEngine(
      deps,
      resolveConfig({
        jobsRoot: root,
        historyFilePath: path.join(root, 'history.json'),
        pollIntervalMs: 5,
        safetyReserveBytes: 0, // FakeStorageGateway reports a fixed 1 GiB free
      }),
    );
    const auth = new AuthController();
    const app = buildRelayServer({
      auth,
      jobs: new EngineJobService(engine),
      logger: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;

    try {
      // ---- client side: main-process relay service ----
      const settingsState: Record<string, unknown> = {};
      const settingsFake = {
        get: () => settingsState,
        update: (patch: Record<string, unknown>) => Object.assign(settingsState, patch),
      };
      const secrets = new MemorySecretStore();
      const client = new ClientRelayService(
        settingsFake as never,
        secrets as unknown as import('../../src/main/secrets.ts').SecretStore,
      );

      // Unpaired status.
      assert.equal((await client.connectionStatus()).state, 'unpaired');

      // Pair using a live code.
      const code = auth.beginPairing().code;
      const paired = await client.pair('127.0.0.1', port, code.toLowerCase());
      assert.equal(paired.ok, true);
      if (paired.ok) {
        assert.equal(paired.value.host, '127.0.0.1');
        assert.equal(paired.value.port, port);
      }
      assert.equal((await client.connectionStatus()).state, 'connected');
      // Token persisted in the secret store only — never in settings.
      assert.ok(secrets.entries.has('client.bearerToken'));
      assert.equal('client.bearerToken' in settingsState, false);

      // Intake → draft with metadata.
      const { jobId } = await client.createIntake(MAGNET);
      const draft = await client.getDraft(jobId);
      assert.equal(draft.state, 'awaiting_selection');
      assert.equal(draft.metadata?.files.length, 2);

      // Confirm selection → authoritative preflight (engine started transfer).
      const confirmed = await client.confirmSelection(jobId, [1, 0]);
      assert.equal(confirmed.ok, true);
      if (confirmed.ok) {
        assert.equal(confirmed.value.selectedFiles, 2);
        assert.equal(confirmed.value.blocked, false);
        assert.ok(confirmed.value.tempZipBytes !== null);
      }

      // startJob replay is idempotent: same job, no duplicate transfer.
      await client.startJob(jobId);

      let job = await client.getJob(jobId);
      for (let i = 0; i < 200 && job.state !== 'complete'; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
        job = await client.getJob(jobId);
      }
      assert.equal(job.state, 'complete');
      assert.equal(job.result?.url, 'https://viking.example/f/xyz');

      // History flows back through /v1/history.
      const history = await client.listHistory();
      assert.equal(history.some((h) => h.id === jobId && h.url !== null), true);

      // Wrong token is rejected by the server (structured unauthorized).
      secrets.entries.set('client.bearerToken', 'bogus-token-value-1234567890');
      await assert.rejects(() => client.getJob(jobId), /authorized/i);
    } finally {
      await app.close();
    }
  });
});


