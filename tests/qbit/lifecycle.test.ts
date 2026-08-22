/** Guarded stop/cleanup: destructive operations require ownership proof. */

import { test, assertEquals, expectThrows } from './harness';
import { createMockFetch, parseForm, textResponse, jsonResponse } from './mock';
import { QbitClient } from '../../src/main/qbit/client';
import { IntakeRegistry } from '../../src/main/qbit/registry';
import { stopJobTorrent, cleanupJobTorrent, discardIntake } from '../../src/main/qbit/lifecycle';
import type { IntakeToken } from '../../src/main/qbit/types';
import { HASH } from './fixtures';

const BASE = 'http://localhost:8080';
const SAVE = 'C:/jobs/job-1';

function makeHarness(torrentOverrides: Record<string, unknown> = {}) {
  let deleted = false;
  let stopped = false;
  let deleteFilesParam: string | undefined;

  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/torrents/info') {
      return jsonResponse([
        {
          hash: HASH,
          name: 'Movie 2024',
          state: 'stoppedUP',
          tags: ['vr_job_j1'],
          category: 'vr_job_j1',
          save_path: SAVE + '/',
          ...torrentOverrides,
        },
      ]);
    }
    if (req.path === '/api/v2/torrents/delete') {
      const form = parseForm(req.body);
      deleted = true;
      deleteFilesParam = form.deleteFiles;
      return textResponse('');
    }
    if (req.path === '/api/v2/torrents/stop') {
      stopped = true;
      return textResponse('');
    }
    throw new Error('unexpected path ' + req.path);
  });

  const client = new QbitClient({ baseUrl: BASE, apiKey: 'qbt_k', fetchImpl: mock.fetchImpl });
  const registry = new IntakeRegistry();
  registry.putJob({
    jobId: 'j1',
    infoHash: HASH,
    selectedIndexes: [0],
    savePath: SAVE,
    tag: 'vr_job_j1',
    category: 'vr_job_j1',
    committedAt: Date.now(),
  });

  return { client, registry, state: { get deleted() { return deleted; }, get stopped() { return stopped; }, get deleteFilesParam() { return deleteFilesParam; } } };
}

test('cleanup succeeds when hash + tag + save path proof all match', async () => {
  const h = makeHarness();
  await cleanupJobTorrent(h.client, h.registry, 'j1', {
    expectedInfoHash: HASH.toUpperCase(), // case-insensitive identity
  });

  assertEquals(h.state.deleted, true, 'torrent deleted');
  assertEquals(h.state.deleteFilesParam, 'true', 'deleteFiles defaults to true');
  assertEquals(h.registry.getJob('j1'), undefined, 'job record removed');
});

test('cleanup refuses on hash mismatch — nothing deleted', async () => {
  const h = makeHarness();
  await expectThrows(
    () =>
      cleanupJobTorrent(h.client, h.registry, 'j1', {
        expectedInfoHash: 'ffffffffffffffffffffffffffffffffffffffff',
      }),
    'OWNERSHIP_MISMATCH',
  );
  assertEquals(h.state.deleted, false);
});

test('cleanup refuses when ownership tag missing (unrelated torrent)', async () => {
  const h = makeHarness({ tags: [], category: '' });
  await expectThrows(
    () =>
      cleanupJobTorrent(h.client, h.registry, 'j1', {
        expectedInfoHash: HASH,
      }),
    'OWNERSHIP_MISMATCH',
  );
  assertEquals(h.state.deleted, false);
});

test('cleanup refuses when save path escapes the per-job directory', async () => {
  const h = makeHarness({ save_path: 'C:/somewhere/else/' });
  await expectThrows(
    () =>
      cleanupJobTorrent(h.client, h.registry, 'j1', {
        expectedInfoHash: HASH,
      }),
    'OWNERSHIP_MISMATCH',
  );
  assertEquals(h.state.deleted, false);
});

test('cleanup requires explicit proof at all', async () => {
  const h = makeHarness();
  await expectThrows(
    () =>
      cleanupJobTorrent(h.client, h.registry, 'j1', {
        expectedInfoHash: '',
      }),
    'OWNERSHIP_MISMATCH',
  );
  assertEquals(h.state.deleted, false);
});

test('cleanup rejects suspicious "all" target', async () => {
  const h = makeHarness();
  await expectThrows(
    () =>
      cleanupJobTorrent(h.client, h.registry, 'j1', {
        expectedInfoHash: 'ALL',
      }),
    'OWNERSHIP_MISMATCH',
  );
  assertEquals(h.state.deleted, false);
});

test('stop is ownership-guarded too', async () => {
  const good = makeHarness();
  await stopJobTorrent(good.client, good.registry, 'j1');
  assertEquals(good.state.stopped, true, 'owned torrent stopped');

  const bad = makeHarness({ tags: [], category: '' });
  await expectThrows(() => stopJobTorrent(bad.client, bad.registry, 'j1'), 'OWNERSHIP_MISMATCH');
  assertEquals(bad.state.stopped, false, 'unowned torrent NOT stopped');
});

test('discardIntake deletes parked fallback torrent without touching files flag data', async () => {
  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/torrents/delete') {
      const form = parseForm(req.body);
      assertEquals(form.deleteFiles, 'false', 'parked intake has no payload worth deleting');
      return textResponse('');
    }
    throw new Error('unexpected path ' + req.path);
  });
  const client = new QbitClient({ baseUrl: BASE, apiKey: 'qbt_k', fetchImpl: mock.fetchImpl });
  const registry = new IntakeRegistry();
  registry.putIntake({
    token: `vr_intake_${HASH}` as IntakeToken,
    source: `magnet:?xt=urn:btih:${HASH}`,
    sourceKind: 'magnet',
    infoHash: HASH,
    infoHashV1: HASH,
    infoHashV2: null,
    name: 'x',
    files: [],
    totalSize: 0,
    isPrivate: null,
    parkedTorrent: true,
    inspectedAt: Date.now(),
  });

  await discardIntake(client, registry, `vr_intake_${HASH}` as IntakeToken);
  assertEquals(mock.callsTo('/torrents/delete').length, 1);
  assertEquals(registry.getIntake(`vr_intake_${HASH}` as IntakeToken), undefined);
});
