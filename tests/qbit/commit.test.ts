/** Commit flow: selection mapping, priority-0 for unselected, duplicate refusal, ordering. */

import { test, assertEquals, assert, expectThrows } from './harness';
import { createMockFetch, parseForm, textResponse, jsonResponse } from './mock';
import { QbitClient } from '../../src/main/qbit/client';
import { IntakeRegistry } from '../../src/main/qbit/registry';
import { inspectTorrent } from '../../src/main/qbit/inspect';
import { commitTorrentSelection } from '../../src/main/qbit/commit';
import {
  DuplicateUnmanagedTorrentError,
  SelectionInvalidError,
} from '../../src/main/qbit/errors';
import type { IntakeToken } from '../../src/main/qbit/types';
import { fetchMetadataFull, fileList, torrentInfo, HASH } from './fixtures';

const BASE = 'http://localhost:8080';
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Movie%202024`;
const SAVE = 'C:/jobs/job-1';

interface Harness {
  client: QbitClient;
  registry: IntakeRegistry;
  mock: ReturnType<typeof createMockFetch>;
  events: string[];
  token: IntakeToken;
}

/**
 * Stateful mock: info returns [] until the torrent is "added"/adopted,
 * then returns the current torrent state. filePrio mutates file priorities.
 * Pass existingOverrides to simulate a pre-existing torrent.
 */
async function setup(
  existingOverrides?: Record<string, unknown>,
  opts: { ignorePrio?: boolean } = {},
): Promise<Harness> {
  const registry = new IntakeRegistry();
  const events: string[] = [];
  let torrentExists = existingOverrides !== undefined;
  const infoOverrides: Record<string, unknown> = existingOverrides ?? {};
  const priorities = [1, 1, 1];

  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/app/webapiVersion') return textResponse('2.11.9');
    if (req.path === '/api/v2/app/version') return textResponse('v5.2.0');
    if (req.path === '/api/v2/torrents/fetchMetadata') return jsonResponse(fetchMetadataFull());
    if (req.path === '/api/v2/torrents/add') {
      events.push('add');
      torrentExists = true;
      return textResponse('Ok.');
    }
    if (req.path === '/api/v2/torrents/info') {
      if (!torrentExists) return jsonResponse([]);
      return jsonResponse([
        torrentInfo({ tags: ['vr_job_j1'], category: 'vr_job_j1', save_path: SAVE + '/', ...infoOverrides }),
      ]);
    }
    if (req.path === '/api/v2/torrents/files') {
      return jsonResponse(fileList(priorities));
    }
    if (req.path === '/api/v2/torrents/filePrio') {
      const form = parseForm(req.body);
      const ids = form.id.split('|').map((n) => Number.parseInt(n, 10));
      const prio = Number.parseInt(form.priority, 10);
      events.push(`prio:${prio}:${ids.join(',')}`);
      if (!opts.ignorePrio) {
        for (const id of ids) priorities[id] = prio;
      }
      return textResponse('');
    }
    if (req.path === '/api/v2/torrents/start') {
      events.push('start');
      return textResponse('');
    }
    if (req.path === '/api/v2/torrents/stop') {
      events.push('stop');
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

  const client = new QbitClient({ baseUrl: BASE, apiKey: 'qbt_k', fetchImpl: mock.fetchImpl });
  const inspected = await inspectTorrent(client, registry, MAGNET);

  return { client, registry, mock, events, token: inspected.token };
}

test('selection maps to priority calls: unselected=0 first, selected=1, then start', async () => {
  const h = await setup({});
  const result = await commitTorrentSelection(h.client, h.registry, {
    token: h.token,
    selectedIndexes: [1],
    jobId: 'j1',
    savePath: SAVE,
  });

  assertEquals(result.tag, 'vr_job_j1');
  assertEquals(result.category, 'vr_job_j1');
  assertEquals(result.infoHash, HASH);
  assertEquals(result.selectedIndexes, [1]);

  const prioEvents = h.events.filter((e) => e.startsWith('prio:'));
  assertEquals(prioEvents[0], 'prio:0:0,2', 'unselected files deselected FIRST');
  assertEquals(prioEvents[1], 'prio:1:1', 'selected files normal priority');

  const startIdx = h.events.indexOf('start');
  const lastPrioIdx = h.events.map((e) => e.startsWith('prio:')).lastIndexOf(true);
  assert(startIdx > lastPrioIdx && lastPrioIdx >= 0, 'start must happen AFTER priorities are applied+verified');

  assert(h.events.includes('setCategory'), 'category set');
  assert(h.events.includes('addTags'), 'job tag added');
});

test('duplicate UNMANAGED identical torrent is refused and never touched', async () => {
  const h = await setup({ tags: [], category: '' }); // exists, no VR markers

  const err = await expectThrows(
    () =>
      commitTorrentSelection(h.client, h.registry, {
        token: h.token,
        selectedIndexes: [0],
        jobId: 'j1',
        savePath: SAVE,
      }),
    'DUPLICATE_UNMANAGED_TORRENT',
  );
  assert(err instanceof DuplicateUnmanagedTorrentError);

  assertEquals(h.events.filter((e) => e === 'add').length, 0, 'no re-add attempted');
  assertEquals(h.events.filter((e) => e.startsWith('prio:')).length, 0, 'no priority mutation');
  assertEquals(h.events.includes('start'), false, 'never started');
});

test('identical torrent owned by ANOTHER job is refused', async () => {
  const h = await setup({ tags: ['vr_job_other'], category: 'vr_job_other' });
  await expectThrows(
    () =>
      commitTorrentSelection(h.client, h.registry, {
        token: h.token,
        selectedIndexes: [0],
        jobId: 'j1',
        savePath: SAVE,
      }),
    'DUPLICATE_UNMANAGED_TORRENT',
  );
});

test('fresh add path adds STOPPED with metadata stop condition before starting', async () => {
  const h = await setup(undefined); // nothing in qBittorrent yet
  await commitTorrentSelection(h.client, h.registry, {
    token: h.token,
    selectedIndexes: [0, 2],
    jobId: 'j1',
    savePath: SAVE,
  });

  const addCalls = h.mock.callsTo('/torrents/add');
  assertEquals(addCalls.length, 1, 'one add');
  const form = parseForm(addCalls[0].body);
  assertEquals(form.stopped, 'true', 'added stopped — no payload can start early');
  assertEquals(form.stopCondition, 'MetadataReceived', 'magnet metadata condition');
  assertEquals(form.category, 'vr_job_j1', 'ownership category at add time');
  assertEquals(form.tags, 'vr_job_j1', 'ownership tag at add time');
  assertEquals(form.savepath, SAVE, 'caller-supplied save path');
  assertEquals(form.autoTMM, 'false', 'autoTMM off so savepath governs');
});

test('priority verification failure prevents start', async () => {
  // Server IGNORES priority changes: files keep reporting all-normal.
  const h = await setup({}, { ignorePrio: true });
  await expectThrows(
    () =>
      commitTorrentSelection(h.client, h.registry, {
        token: h.token,
        selectedIndexes: [0],
        jobId: 'j1',
        savePath: SAVE,
      }),
    'SELECTION_NOT_APPLIED',
  );
  assert(!h.events.includes('start'), 'must NOT start when selection not confirmed');
});

test('invalid selections are rejected without side effects', async () => {
  const h = await setup({});

  await expectThrows(
    () =>
      commitTorrentSelection(h.client, h.registry, {
        token: h.token,
        selectedIndexes: [],
        jobId: 'j1',
        savePath: SAVE,
      }),
    'SELECTION_INVALID',
  );
  const err = await expectThrows(
    () =>
      commitTorrentSelection(h.client, h.registry, {
        token: h.token,
        selectedIndexes: [99],
        jobId: 'j1',
        savePath: SAVE,
      }),
    'SELECTION_INVALID',
  );
  assert(err instanceof SelectionInvalidError);

  await expectThrows(
    () =>
      commitTorrentSelection(h.client, h.registry, {
        token: h.token,
        selectedIndexes: [0],
        jobId: 'bad job id with spaces',
        savePath: SAVE,
      }),
    'VALIDATION_FAILED',
  );
  assertEquals(
    h.events.filter((e) => e === 'add' || e.startsWith('prio:') || e === 'start').length,
    0,
    'no mutating calls on invalid input',
  );
});

test('unknown intake token raises INTAKE_NOT_FOUND', async () => {
  const h = await setup({});
  await expectThrows(
    () =>
      commitTorrentSelection(h.client, h.registry, {
        token: 'vr_intake_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as IntakeToken,
        selectedIndexes: [0],
        jobId: 'j1',
        savePath: SAVE,
      }),
    'INTAKE_NOT_FOUND',
  );
});

test('qBittorrent-reported error state after start stops the torrent (TORRENT_ERRORED)', async () => {
  const h = await setup({});
  // After start, info reports an error state.
  const originalInfo = h.mock.callsTo('/torrents/info');
  void originalInfo;
  // Patch: make every post-start info return missingFiles by using overrides
  // through a fresh harness with pre-existing owned torrent in error state.
  const h2 = await setup({ state: 'missingFiles' });
  await expectThrows(
    () =>
      commitTorrentSelection(h2.client, h2.registry, {
        token: h2.token,
        selectedIndexes: [0],
        jobId: 'j1',
        savePath: SAVE,
      }),
    'TORRENT_ERRORED',
  );
  assert(h2.events.includes('stop'), 'torrent stopped for containment');
});
