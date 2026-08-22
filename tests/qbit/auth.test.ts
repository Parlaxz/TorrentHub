/** Auth behavior: API-key header, cookie login fallback, error mapping. */

import { test, assertEquals, assert, expectThrows } from './harness';
import { createMockFetch, textResponse } from './mock';
import { QbitClient } from '../../src/main/qbit/client';
import { QbitAuthError, QbitUnreachableError } from '../../src/main/qbit/errors';
import { versionRoutes } from './fixtures';

test('API key is sent as Authorization Bearer on every request', async () => {
  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/app/webapiVersion') return textResponse('2.11.9');
    if (req.path === '/api/v2/app/version') return textResponse('v5.2.0');
    throw new Error('unexpected path ' + req.path);
  });
  const client = new QbitClient({
    baseUrl: 'http://localhost:8080',
    apiKey: 'qbt_secretkey123',
    fetchImpl: mock.fetchImpl,
  });

  await client.capabilities();

  assert(mock.requests.length >= 2, 'expected at least two requests');
  for (const req of mock.requests) {
    assertEquals(req.headers['authorization'], 'Bearer qbt_secretkey123', 'bearer header');
    assertEquals(req.headers['referer'], 'http://localhost:8080', 'referer for CSRF');
  }
});

test('HTTP 403 maps to QbitAuthError', async () => {
  const mock = createMockFetch(() => textResponse('Forbidden', 403));
  const client = new QbitClient({
    baseUrl: 'http://localhost:8080',
    apiKey: 'qbt_bad',
    fetchImpl: mock.fetchImpl,
  });
  const err = await expectThrows(() => client.capabilities(), 'QBIT_AUTH_FAILED');
  assert(err instanceof QbitAuthError, 'should be QbitAuthError instance');
});

test('cookie-mode: logs in once and sends SID cookie + Referer afterwards', async () => {
  let loginCalls = 0;
  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/auth/login') {
      loginCalls += 1;
      assertEquals(req.method, 'POST', 'login method');
      assert(req.body?.includes('username=alice'), 'login body carries username');
      return textResponse('Ok.', 200, { 'set-cookie': 'SID=sess-abc; path=/' });
    }
    if (req.path === '/api/v2/app/webapiVersion') return textResponse('2.11.9');
    if (req.path === '/api/v2/app/version') return textResponse('v5.2.0');
    throw new Error('unexpected path ' + req.path);
  });

  const client = new QbitClient({
    baseUrl: 'http://localhost:8080',
    username: 'alice',
    password: 'secret',
    fetchImpl: mock.fetchImpl,
  });

  await client.capabilities();
  await client.capabilities(); // cached; no extra auth traffic

  assertEquals(loginCalls, 1, 'exactly one proactive login');
  const apiCalls = mock.requests.filter((r) => r.path !== '/api/v2/auth/login');
  assert(apiCalls.length >= 2, 'version endpoints were called');
  for (const req of apiCalls) {
    assertEquals(req.headers['cookie'], 'SID=sess-abc', 'SID cookie attached to API calls');
    assertEquals(req.headers['referer'], 'http://localhost:8080', 'Referer matches Host for CSRF');
  }
});

test('failed cookie login maps to QbitAuthError', async () => {
  const mock = createMockFetch((req) => {
    if (req.path === '/api/v2/auth/login') return textResponse('Fails.', 200);
    // Any API call before auth would be 403 in real qBittorrent.
    return textResponse('Forbidden', 403);
  });
  const client = new QbitClient({
    baseUrl: 'http://localhost:8080',
    username: 'alice',
    password: 'wrong',
    fetchImpl: mock.fetchImpl,
  });
  await expectThrows(() => client.capabilities(), 'QBIT_AUTH_FAILED');
});

test('connection refused maps to QbitUnreachableError', async () => {
  const mock = createMockFetch(() => {
    throw new TypeError('fetch failed (ECONNREFUSED)');
  });
  const client = new QbitClient({
    baseUrl: 'http://localhost:9999',
    apiKey: 'qbt_x',
    fetchImpl: mock.fetchImpl,
  });
  const err = await expectThrows(() => client.capabilities(), 'QBIT_UNREACHABLE');
  assert(err instanceof QbitUnreachableError, 'should be QbitUnreachableError');
});

test('request timeout maps to QbitUnreachableError with timeout message', async () => {
  const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const mock = createMockFetch(() => {
    throw abortErr;
  });
  const client = new QbitClient({
    baseUrl: 'http://localhost:8080',
    apiKey: 'qbt_x',
    timeoutMs: 25,
    fetchImpl: mock.fetchImpl,
  });
  const err = await expectThrows(() => client.capabilities(), 'QBIT_UNREACHABLE');
  assert(err.message.includes('timed out'), `message should mention timeout: ${err.message}`);
});

// keep import used
void versionRoutes;
