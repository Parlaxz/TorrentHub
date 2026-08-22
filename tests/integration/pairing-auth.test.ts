/**
 * Integration: pairing code → client token → authenticated call, plus
 * safeStorage-backed auth persistence across "restarts" (M13).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AuthController } from '../../src/main/auth/index.ts';
import { TokenStore } from '../../src/main/auth/tokenStore.ts';
import { buildRelayServer } from '../../src/main/relay/http/app.ts';
import { SafeStorageTokenPersistence } from '../../src/main/server/auth-persistence.ts';

function fakeJobService(): unknown {
  return {
    async createIntake() {
      throw new Error('not used');
    },
    async getIntake() {
      return null;
    },
    async createJob() {
      throw new Error('not used');
    },
    async listJobs() {
      return [];
    },
    async getJob() {
      return null;
    },
    async cancelJob() {
      throw new Error('not used');
    },
    async retryPackaging() {
      throw new Error('not used');
    },
    async retryUpload() {
      throw new Error('not used');
    },
    async recheckStorage() {
      throw new Error('not used');
    },
    async listHistory() {
      return [];
    },
  };
}

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

describe('integration: pairing and auth persistence', () => {
  it('pairs over HTTP and the returned token authenticates /v1 calls', async () => {
    const auth = new AuthController();
    const app = buildRelayServer({ auth, jobs: fakeJobService() as never, logger: false });

    const issued = auth.beginPairing();

    const pairRes = await app.inject({
      method: 'POST',
      url: '/v1/pair',
      payload: { code: issued.code, name: 'client-pc' },
    });
    assert.equal(pairRes.statusCode, 200);
    const { token, clientId } = pairRes.json();
    assert.ok(token.length >= 40);

    const jobsRes = await app.inject({
      method: 'GET',
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(jobsRes.statusCode, 200);
    assert.deepEqual(jobsRes.json(), { jobs: [] });

    // Revocation kills the token immediately.
    assert.equal(auth.revokeClient(clientId), 1);
    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(afterRevoke.statusCode, 401);

    await app.close();
  });

  it('persists token digests + HMAC secret so paired clients survive restarts', async () => {
    const secrets = new MemorySecretStore();
    const persistence = new SafeStorageTokenPersistence(secrets as never);

    const secret = persistence.ensureSecret();
    const store1 = new TokenStore(persistence, secret);
    const issued = store1.issue('laptop');

    // Simulated restart: fresh store, same persisted secret + digests.
    const secret2 = persistence.ensureSecret();
    assert.equal(secret2.toString('hex'), secret.toString('hex'));
    const store2 = new TokenStore(persistence, secret2);
    const client = store2.verify(issued.token);
    assert.ok(client);
    assert.equal(client.clientId, issued.clientId);
    assert.equal(client.name, 'laptop');

    // Raw tokens are never stored — only HMAC digests.
    const rawDump = [...secrets.entries.values()].join('\n');
    assert.equal(rawDump.includes(issued.token), false);
    assert.ok(rawDump.includes(issued.clientId));
  });
});
