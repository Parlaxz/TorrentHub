/**
 * Integration seam A2 → A5: QbitTorrentGateway over a mocked WebUI.
 *
 * Covers: metadata → canonical selected indexes → commit with job-specific
 * ownership markers (vr_job_<jobId>) → completed selected source paths
 * derived from content_path layout and validated inside the per-job root →
 * proof-guarded deletion (correct proof deletes; tampered proof refuses).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createMockFetch, jsonResponse, parseForm, textResponse } from '../qbit/mock.ts';
import { HASH, fetchMetadataFull, fileList, torrentInfo } from '../qbit/fixtures.ts';
import { QbitTorrentService } from '../../src/main/qbit/service.ts';
import { QbitTorrentGateway } from '../../src/main/integration/qbit-gateway.ts';

const BASE = 'http://localhost:8080';
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Movie%202024`;
const SAVE = 'C:/jobs/job-1';
const JOB_ID = 'j1';

interface World {
  gateway: QbitTorrentGateway;
  mock: ReturnType<typeof createMockFetch>;
  events: string[];
  deleted: Array<{ hash: string; deleteFiles: boolean }>;
}

async function setup(): Promise<World> {
  const events: string[] = [];
  const deleted: Array<{ hash: string; deleteFiles: boolean }> = [];
  let added = false;
  let started = false;
  let pollCount = 0;
  const priorities = [1, 1, 1];

  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/app/webapiVersion') return textResponse('2.11.9');
    if (req.path === '/api/v2/app/version') return textResponse('v5.2.0');
    if (req.path === '/api/v2/torrents/fetchMetadata') return jsonResponse(fetchMetadataFull());
    if (req.path === '/api/v2/torrents/add') {
      const form = parseForm(req.body);
      events.push(`add:stopped=${form.stopped}:savepath=${form.savepath}`);
      added = true;
      return textResponse('Ok.');
    }
    if (req.path === '/api/v2/torrents/info') {
      if (!added) return jsonResponse([]);
      return jsonResponse([
        torrentInfo({
          tags: [`vr_job_${JOB_ID}`],
          category: `vr_job_${JOB_ID}`,
          save_path: SAVE + '/',
        }),
      ]);
    }
    if (req.path === '/api/v2/torrents/files') {
      if (started) pollCount += 1;
      const progress = pollCount >= 2 ? [1, 1, 0] : [0, 0, 0];
      return jsonResponse(fileList(priorities, progress));
    }
    if (req.path === '/api/v2/torrents/filePrio') {
      const form = parseForm(req.body);
      const ids = form.id.split('|').map((n) => Number.parseInt(n, 10));
      const prio = Number.parseInt(form.priority, 10);
      events.push(`prio:${prio}:${ids.join(',')}`);
      for (const id of ids) priorities[id] = prio;
      return textResponse('');
    }
    if (req.path === '/api/v2/torrents/start') {
      events.push('start');
      started = true;
      return textResponse('');
    }
    if (req.path === '/api/v2/torrents/stop') {
      events.push('stop');
      return textResponse('');
    }
    if (req.path === '/api/v2/torrents/delete') {
      const form = parseForm(req.body);
      deleted.push({ hash: form.hashes, deleteFiles: form.deleteFiles === 'true' });
      return textResponse('');
    }
    if (
      req.path.endsWith('/createCategory') ||
      req.path.endsWith('/createTags') ||
      req.path.endsWith('/addTags') ||
      req.path.endsWith('/setCategory') ||
      req.path.endsWith('/removeTags')
    ) {
      events.push(req.path.split('/').pop()!);
      return textResponse('');
    }
    throw new Error('unexpected path ' + req.path);
  });

  const qbit = new QbitTorrentService({ baseUrl: BASE, apiKey: 'qbt_k', fetchImpl: mock.fetchImpl });
  return { gateway: new QbitTorrentGateway(() => qbit), mock, events, deleted };
}

describe('integration: A2 -> A5 qbit gateway', () => {
  it('fetches metadata into canonical file entries', async () => {
    const world = await setup();
    const meta = await world.gateway.fetchMetadata({ kind: 'magnet', value: MAGNET });
    assert.equal(meta.name, 'Movie 2024');
    assert.deepEqual(
      meta.files,
      [
        { index: 0, path: 'Movie/movie.mkv', sizeBytes: 1_000_000 },
        { index: 1, path: 'Movie/sample.mkv', sizeBytes: 50_000 },
        { index: 2, path: 'Movie/subs.srt', sizeBytes: 10_000 },
      ],
    );
    assert.equal(meta.totalSizeBytes, 1_060_000);
  });

  it('commits selection with job-specific ownership and starts only after verify', async () => {
    const world = await setup();
    await world.gateway.fetchMetadata({ kind: 'magnet', value: MAGNET });
    const handle = await world.gateway.addTorrent(
      { kind: 'magnet', value: MAGNET },
      { selectedIndexes: [0], outputDir: SAVE, jobId: JOB_ID },
    );

    assert.equal(handle.infoHash, HASH);
    assert.equal(handle.jobId, JOB_ID);
    assert.equal(handle.savePathPrefix, SAVE);

    // Race-free ordering: deselect FIRST, select, then start.
    const prioEvents = world.events.filter((e) => e.startsWith('prio:'));
    assert.deepEqual(prioEvents, ['prio:0:1,2', 'prio:1:0']);
    assert.ok(world.events.indexOf('start') > world.events.indexOf('prio:1:0'));
    assert.ok(
      world.events.some((e) => e.startsWith('add:stopped=true')),
      `events were: ${JSON.stringify(world.events)}`,
    );
  });

  it('reports selected completion and derives validated absolute paths', async () => {
    const world = await setup();
    await world.gateway.fetchMetadata({ kind: 'magnet', value: MAGNET });
    const handle = await world.gateway.addTorrent(
      { kind: 'magnet', value: MAGNET },
      { selectedIndexes: [0, 1], outputDir: SAVE, jobId: JOB_ID },
    );

    const partial = await world.gateway.getProgress(handle);
    assert.equal(partial.selectedComplete, false);

    // All selected files complete; deselected file (index 2) ignored.
    const done = await world.gateway.getProgress(handle);
    assert.equal(done.selectedComplete, true);
    assert.equal(done.totalSelectedBytes, 1_050_000);
    assert.ok(done.selectedFiles);
    assert.deepEqual(
      done.selectedFiles!.map((f) => f.index),
      [0, 1],
    );
    const expectedBase = path.dirname(path.join(SAVE, 'Movie 2024'));
    assert.deepEqual(
      done.selectedFiles!.map((f) => f.absolutePath),
      [
        path.join(expectedBase, 'Movie/movie.mkv'),
        path.join(expectedBase, 'Movie/sample.mkv'),
      ],
    );
  });

  it('deletes only with full ownership proof; tampered proof refuses', async () => {
    const world = await setup();
    await world.gateway.fetchMetadata({ kind: 'magnet', value: MAGNET });
    const handle = await world.gateway.addTorrent(
      { kind: 'magnet', value: MAGNET },
      { selectedIndexes: [0], outputDir: SAVE, jobId: JOB_ID },
    );

    await world.gateway.deleteOwned(handle, true);
    assert.deepEqual(world.deleted, [{ hash: HASH, deleteFiles: true }]);
    assert.equal((await lastDeleteCount(world)) === 1, true);

    // Tampered identity must refuse BEFORE any destructive call.
    await assert.rejects(
      () =>
        world.gateway.deleteOwned(
          { ...handle, infoHash: 'ffffffffffffffffffffffffffffffffffffffff' },
          true,
        ),
      /proof|hash|mismatch|Refusing/i,
    );
    assert.equal(world.deleted.length, 1);
  });
});

async function lastDeleteCount(world: World): Promise<number> {
  return world.deleted.length;
}
