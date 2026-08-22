/** Metadata inspection: fetchMetadata polling, validation, malformed data, fallback parking. */

import { test, assertEquals, assert, expectThrows } from './harness';
import { createMockFetch, parseForm, textResponse, jsonResponse } from './mock';
import { QbitClient } from '../../src/main/qbit/client';
import { IntakeRegistry } from '../../src/main/qbit/registry';
import { inspectTorrent } from '../../src/main/qbit/inspect';
import {
  InvalidTorrentSourceError,
} from '../../src/main/qbit/errors';
import { fetchMetadataFull, pendingInfoHashOnly, fileList, HASH } from './fixtures';

const BASE = 'http://localhost:8080';

function makeClient(
  mockFetch: typeof fetch,
  opts: { min?: string; apiKey?: string; username?: string } = {},
): QbitClient {
  const useCookie = opts.username !== undefined;
  return new QbitClient({
    baseUrl: BASE,
    apiKey: useCookie ? undefined : (opts.apiKey ?? 'qbt_k'),
    username: opts.username,
    password: useCookie ? 'pw' : undefined,
    fetchImpl: mockFetch,
    minWebApiVersion: opts.min,
  });
}

test('rejects invalid sources locally without any HTTP call', async () => {
  const mock = createMockFetch(() => {
    throw new Error('must not be called');
  });
  const client = makeClient(mock.fetchImpl);
  const registry = new IntakeRegistry();

  for (const bad of ['', '   ', 'ftp://example.com/a.torrent', 'just some text']) {
    const err = await expectThrows(
      () => inspectTorrent(client, registry, bad),
      'TORRENT_SOURCE_INVALID',
    );
    assert(err instanceof InvalidTorrentSourceError);
  }
  assertEquals(mock.requests.length, 0, 'no HTTP calls expected');
});

test('accepts magnet with btih and http(s) .torrent URLs', async () => {
  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/app/webapiVersion') return textResponse('2.11.9');
    if (req.path === '/api/v2/app/version') return textResponse('v5.2.0');
    if (req.path === '/api/v2/torrents/fetchMetadata') return jsonResponse(fetchMetadataFull());
    throw new Error('unexpected path ' + req.path);
  });
  const client = makeClient(mock.fetchImpl);
  const registry = new IntakeRegistry();

  const magnet = `magnet:?xt=urn:btih:${HASH}&dn=Movie%202024`;
  const inspected = await inspectTorrent(client, registry, magnet);

  assertEquals(inspected.name, 'Movie 2024');
  assertEquals(inspected.infoHash, HASH);
  assertEquals(inspected.files.length, 3);
  assertEquals(inspected.files[1], { index: 1, path: 'Movie/sample.mkv', size: 50_000 });
  assertEquals(inspected.totalSize, 1_060_000);
  assertEquals(inspected.sourceKind, 'magnet');
  assert(inspected.token.startsWith('vr_intake_'), 'token format');

  const urlSource = 'https://example.com/movie.torrent';
  const inspectedUrl = await inspectTorrent(client, registry, urlSource);
  assertEquals(inspectedUrl.sourceKind, 'url');
  assertEquals(inspectedUrl.token, inspected.token, 'same hash -> same token');
});

test('fetchMetadata polls 202 until metadata arrives', async () => {
  let calls = 0;
  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/app/webapiVersion') return textResponse('2.11.9');
    if (req.path === '/api/v2/app/version') return textResponse('v5.2.0');
    if (req.path === '/api/v2/torrents/fetchMetadata') {
      calls += 1;
      // form field `source` must carry the original source
      const form = parseForm(req.body);
      assert(typeof form.source === 'string' && form.source.length > 0, 'source param sent');
      if (calls <= 2) return jsonResponse(pendingInfoHashOnly(), 202);
      return jsonResponse(fetchMetadataFull());
    }
    throw new Error('unexpected path ' + req.path);
  });

  const client = makeClient(mock.fetchImpl);
  const registry = new IntakeRegistry();
  const inspected = await inspectTorrent(client, registry, `magnet:?xt=urn:btih:${HASH}`, {
    pollIntervalMs: 1,
  });

  assertEquals(calls, 3, 'two pending polls then ready');
  assertEquals(inspected.files.length, 3);
  assert(registry.getIntake(inspected.token) !== undefined, 'intake registered');
});

test('fetchMetadata timeout raises MetadataUnavailableError', async () => {
  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/app/webapiVersion') return textResponse('2.11.9');
    if (req.path === '/api/v2/app/version') return textResponse('v5.2.0');
    if (req.path === '/api/v2/torrents/fetchMetadata') return jsonResponse(pendingInfoHashOnly(), 202);
    throw new Error('unexpected path ' + req.path);
  });
  const client = makeClient(mock.fetchImpl);
  const registry = new IntakeRegistry();
  await expectThrows(
    () =>
      inspectTorrent(client, registry, `magnet:?xt=urn:btih:${HASH}`, {
        metadataTimeoutMs: 30,
        pollIntervalMs: 5,
      }),
    'METADATA_UNAVAILABLE',
  );
});

test('server-side rejection of a bad source maps to InvalidTorrentSourceError', async () => {
  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/app/webapiVersion') return textResponse('2.11.9');
    if (req.path === '/api/v2/app/version') return textResponse('v5.2.0');
    if (req.path === '/api/v2/torrents/fetchMetadata')
      return textResponse('Unable to parse "garbage"', 400);
    throw new Error('unexpected path ' + req.path);
  });
  const client = makeClient(mock.fetchImpl);
  await expectThrows(
    () => inspectTorrent(client, new IntakeRegistry(), 'magnet:?invalid'),
    'TORRENT_SOURCE_INVALID',
  );
});

test('metadata without files maps to MalformedMetadataError', async () => {
  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/app/webapiVersion') return textResponse('2.11.9');
    if (req.path === '/api/v2/app/version') return textResponse('v5.2.0');
    if (req.path === '/api/v2/torrents/fetchMetadata')
      return jsonResponse({ hash: HASH, infohash_v1: HASH, infohash_v2: '', info: { files: [], length: 0, name: '', piece_length: 1, pieces_num: 0, private: false } });
    throw new Error('unexpected path ' + req.path);
  });
  const client = makeClient(mock.fetchImpl);
  await expectThrows(
    () => inspectTorrent(client, new IntakeRegistry(), `magnet:?xt=urn:btih:${HASH}`),
    'METADATA_MALFORMED',
  );
});

test('fallback tier parks a stopped intake torrent with stopCondition=MetadataReceived', async () => {
  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/auth/login') {
      return textResponse('Ok.', 200, { 'set-cookie': 'SID=sess-1; path=/' });
    }
    if (req.path === '/api/v2/app/webapiVersion') return textResponse('2.11.2');
    if (req.path === '/api/v2/app/version') return textResponse('v5.1.0');
    if (req.path === '/api/v2/torrents/add') {
      const form = parseForm(req.body);
      assertEquals(form.stopped, 'true', 'added stopped');
      assertEquals(form.stopCondition, 'MetadataReceived', 'metadata stop condition');
      assertEquals(form.category, 'vr_intake', 'quarantine category');
      assertEquals(form.autoTMM, 'false', 'no autoTMM');
      assert((form.savepath ?? '').length > 0, 'quarantine savepath supplied');
      return textResponse('Ok.');
    }
    if (req.path === '/api/v2/torrents/info') {
      return jsonResponse([
        {
          hash: HASH,
          name: 'Movie 2024',
          state: 'stoppedDL',
          progress: 0,
          size: 1060000,
          total_size: 1060000,
          downloaded: 0,
          dlspeed: 0,
          upspeed: 0,
          eta: 8640000,
          num_seeds: 0,
          num_complete: -1,
          num_leechs: 0,
          num_incomplete: -1,
          category: 'vr_intake',
          tags: ['vr_intake'],
          save_path: 'C:/temp/vr-intake/',
          content_path: '',
          added_on: Math.floor(Date.now() / 1000),
          availability: 0,
          amount_left: 1060000,
          completed: 0,
          downloaded_session: 0,
          completion_on: 0,
        },
      ]);
    }
    if (req.path === '/api/v2/torrents/files') return jsonResponse(fileList());
    throw new Error('unexpected path ' + req.path);
  });

  const client = makeClient(mock.fetchImpl, { min: '2.11.0', username: 'alice' });
  const registry = new IntakeRegistry();
  const inspected = await inspectTorrent(client, registry, `magnet:?xt=urn:btih:${HASH}`, {
    pollIntervalMs: 1,
    intakeSavePath: 'C:/temp/vr-intake',
  });

  assertEquals(inspected.files.length, 3);
  const record = registry.getIntake(inspected.token);
  assert(record !== undefined, 'record stored');
  assertEquals(record!.parkedTorrent, true, 'fallback leaves parked torrent');
});
