/** Version gate + capability tier detection. */

import { test, assert, expectThrows } from './harness';
import { createMockFetch, textResponse } from './mock';
import { QbitClient, compareVersions } from '../../src/main/qbit/client';
import { QbitUnsupportedVersionError } from '../../src/main/qbit/errors';

function clientFor(webApi: string, qbt: string, opts: { apiKey?: string; min?: string; username?: string }) {
  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/auth/login') {
      return textResponse('Ok.', 200, { 'set-cookie': 'SID=sess-1; path=/' });
    }
    if (req.path === '/api/v2/app/webapiVersion') return textResponse(webApi);
    if (req.path === '/api/v2/app/version') return textResponse(qbt);
    throw new Error('unexpected path ' + req.path);
  });
  const client = new QbitClient({
    baseUrl: 'http://localhost:8080',
    apiKey: opts.apiKey,
    username: opts.username,
    password: opts.username !== undefined ? 'pw' : undefined,
    minWebApiVersion: opts.min,
    fetchImpl: mock.fetchImpl,
  });
  return { client, mock };
}

test('server below minimum WebAPI version is rejected', async () => {
  const { client } = clientFor('2.11.2', 'v5.1.2', { apiKey: 'qbt_k' });
  const err = await expectThrows(() => client.capabilities(), 'QBIT_UNSUPPORTED_VERSION');
  assert(err instanceof QbitUnsupportedVersionError, 'typed error instance');
});

test('exactly the minimum version passes', async () => {
  const { client } = clientFor('2.11.9', 'v5.2.0', { apiKey: 'qbt_k' });
  const caps = await client.capabilities();
  assert(caps.tier === 'fetchMetadata', `expected fetchMetadata tier, got ${caps.tier}`);
});

test('older server with lowered minimum uses addStopCondition fallback tier', async () => {
  const { client } = clientFor('2.11.2', 'v5.1.0', { min: '2.11.0', username: 'alice' });
  const caps = await client.capabilities();
  assert(caps.tier === 'addStopCondition', `expected fallback tier, got ${caps.tier}`);
});

test('API key against pre-5.2 qBittorrent is rejected (keys require >= 5.2.0)', async () => {
  const { client } = clientFor('2.11.7', 'v5.1.2', { apiKey: 'qbt_x', min: '2.11.0' });
  await expectThrows(() => client.capabilities(), 'QBIT_UNSUPPORTED_VERSION');
});

test('missing webapiVersion endpoint (ancient server) is unsupported', async () => {
  const mock = createMockFetch(() => textResponse('Not Found', 404));
  const client = new QbitClient({
    baseUrl: 'http://localhost:8080',
    apiKey: 'qbt_x',
    fetchImpl: mock.fetchImpl,
  });
  await expectThrows(() => client.capabilities(), 'QBIT_UNSUPPORTED_VERSION');
});

test('compareVersions orders correctly', () => {
  assert(compareVersions('2.11.9', '2.11.9') === 0);
  assert(compareVersions('2.11.9', '2.11.8') > 0);
  assert(compareVersions('2.11.0', '2.12.0') < 0);
  assert(compareVersions('3.0', '2.99.99') > 0);
});
