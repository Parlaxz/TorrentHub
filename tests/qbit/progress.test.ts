/** Progress mapping, semantic classification, and selected-files completion semantics. */

import { test, assertEquals } from './harness';
import { createMockFetch, jsonResponse } from './mock';
import { QbitClient } from '../../src/main/qbit/client';
import { IntakeRegistry } from '../../src/main/qbit/registry';
import { getJobProgress, getSelectedFilesCompletion, computeCompletion } from '../../src/main/qbit/progress';
import { classifyState, normalizeEta } from '../../src/main/qbit/statemap';
import { fileList, torrentInfo, HASH } from './fixtures';

const BASE = 'http://localhost:8080';

function makeHarness(infoOverrides: Record<string, unknown>, fileProgress: number[], filePriorities?: number[]) {
  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/torrents/info') return jsonResponse([torrentInfo(infoOverrides)]);
    if (req.path === '/api/v2/torrents/files') return jsonResponse(fileList(filePriorities, fileProgress));
    throw new Error('unexpected path ' + req.path);
  });
  const client = new QbitClient({ baseUrl: BASE, apiKey: 'qbt_k', fetchImpl: mock.fetchImpl });
  const registry = new IntakeRegistry();
  registry.putJob({
    jobId: 'j1',
    infoHash: HASH,
    selectedIndexes: [0, 2], // deselected: index 1 (sample.mkv)
    savePath: 'C:/jobs/job-1',
    tag: 'vr_job_j1',
    category: 'vr_job_j1',
    committedAt: Date.now(),
  });
  return { client, registry };
}

test('progress maps qBittorrent fields to the Viking Relay snapshot', async () => {
  const h = makeHarness({}, [1, 0.4, 0]); // selected files: movie done, subs not started
  const p = await getJobProgress(h.client, h.registry, 'j1');

  assertEquals(p.infoHash, HASH);
  assertEquals(p.stateRaw, 'downloading');
  assertEquals(p.classification, 'downloading');
  assertEquals(p.downloadSpeedBps, 262_144);
  assertEquals(p.uploadSpeedBps, 1_024);
  assertEquals(p.etaSeconds, 120);
  assertEquals(p.seedsConnected, 3);
  assertEquals(p.seedsSwarm, 12);
  assertEquals(p.peersConnected, 2);
  assertEquals(p.peersSwarm, 40);
  assertEquals(p.downloadedBytes, 530_000);

  // wanted bytes: only indexes 0 and 2 -> 1_000_000 + 10_000
  assertEquals(p.completion.wantedBytes, 1_010_000);
  // downloaded wanted: 1_000_000*1 + 10_000*0
  assertEquals(p.completion.downloadedWantedBytes, 1_000_000);
  assertEquals(p.completion.complete, false);
  assertEquals(p.completion.incompleteSelectedIndexes, [2]);
});

test('ETA infinity sentinel and negative ETA map to null; -1 swarm counts map to null', async () => {
  const h = makeHarness({ eta: 8_640_000, num_complete: -1, num_incomplete: -1 }, [0, 0, 0]);
  const p = await getJobProgress(h.client, h.registry, 'j1');
  assertEquals(p.etaSeconds, null);
  assertEquals(p.seedsSwarm, null);
  assertEquals(p.peersSwarm, null);
  assertEquals(normalizeEta(-5), null);
});

test('zero seeds / zero speed is NOT fatal — waiting_for_peers classification', async () => {
  const h = makeHarness(
    {
      state: 'stalledDL',
      dlspeed: 0,
      upspeed: 0,
      eta: 8_640_000,
      num_seeds: 0,
      num_complete: 0,
      num_leechs: 0,
      num_incomplete: 0,
    },
    [0, 0, 0],
  );
  const p = await getJobProgress(h.client, h.registry, 'j1'); // must resolve
  assertEquals(p.seedsConnected, 0);
  assertEquals(p.downloadSpeedBps, 0);
  assertEquals(p.classification, 'waiting_for_peers');
});

test('state classification covers the current WebAPI state set', () => {
  assertEquals(classifyState('downloading'), 'downloading');
  assertEquals(classifyState('forcedDL'), 'downloading');
  assertEquals(classifyState('metaDL'), 'metadata');
  assertEquals(classifyState('stalledDL'), 'waiting_for_peers');
  assertEquals(classifyState('queuedDL'), 'queued');
  assertEquals(classifyState('stoppedDL'), 'stopped');
  assertEquals(classifyState('uploading'), 'completed');
  assertEquals(classifyState('stalledUP'), 'completed');
  assertEquals(classifyState('stoppedUP'), 'completed');
  assertEquals(classifyState('checkingResumeData'), 'checking');
  assertEquals(classifyState('moving'), 'moving');
  assertEquals(classifyState('error'), 'error');
  assertEquals(classifyState('missingFiles'), 'error');
  assertEquals(classifyState('pausedDL'), 'unknown', 'pre-2.11 states are NOT silently accepted');
  assertEquals(classifyState('something-new'), 'unknown');
});

test('selected completion ignores deselected files entirely', async () => {
  // Deselected index 1 stuck at 0% must not block completion.
  const h = makeHarness({ progress: 0.94 }, [1, 0, 1]);
  const completion = await getSelectedFilesCompletion(h.client, h.registry, 'j1');
  assertEquals(completion.complete, true, 'all SELECTED files complete');
  assertEquals(completion.selectedCount, 2);
  assertEquals(completion.completedCount, 2);
  assertEquals(completion.incompleteSelectedIndexes, []);
});

test('completion uses the stored selection list as canonical truth, not disk contents', () => {
  const result = computeCompletion(
    { selectedIndexes: [0, 2] },
    fileList([1, 1, 1], [1, 1, 0]).map((f) => f as never),
  );
  assertEquals(result.complete, false, 'subs.srt incomplete -> job not complete');
  assertEquals(result.incompleteSelectedIndexes, [2]);
  assertEquals(result.wantedBytes, 1_010_000);
});

test('missing metadata degrades completion to zeros instead of throwing', async () => {
  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/torrents/info') return jsonResponse([torrentInfo({})]);
    if (req.path === '/api/v2/torrents/files') return jsonResponse([]);
    throw new Error('unexpected path ' + req.path);
  });
  const client = new QbitClient({ baseUrl: BASE, apiKey: 'qbt_k', fetchImpl: mock.fetchImpl });
  const registry = new IntakeRegistry();
  registry.putJob({
    jobId: 'j1',
    infoHash: HASH,
    selectedIndexes: [0],
    savePath: 'C:/x',
    tag: 'vr_job_j1',
    category: 'vr_job_j1',
    committedAt: Date.now(),
  });

  const completion = await getSelectedFilesCompletion(client, registry, 'j1');
  assertEquals(completion.complete, false);
  assertEquals(completion.wantedBytes, 0);
});

test('unknown job id raises INTAKE_NOT_FOUND', async () => {
  const h = makeHarness({}, [0, 0, 0]);
  let threw = false;
  try {
    await getJobProgress(h.client, h.registry, 'nope');
  } catch (err) {
    threw = (err as { code?: string }).code === 'INTAKE_NOT_FOUND';
  }
  assertEquals(threw, true, 'expected INTAKE_NOT_FOUND');
});
