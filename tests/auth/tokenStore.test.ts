import assert from "node:assert/strict";
import { test } from "node:test";
import { TokenStore, type StoredToken } from "../../src/main/auth/index.js";

test("issue then verify round-trips and rejects unknown tokens", () => {
  const store = new TokenStore(undefined, Buffer.alloc(32, 1));
  const issued = store.issue("desk");
  const meta = store.verify(issued.token);
  assert.ok(meta);
  assert.equal(meta.clientId, issued.clientId);
  assert.equal(meta.name, "desk");
  assert.equal(meta.revoked, false);
  assert.equal(store.verify("not-a-real-token-value-123456"), null);
});

test("tampered tokens are rejected", () => {
  const store = new TokenStore(undefined, Buffer.alloc(32, 1));
  const { token } = store.issue("desk");
  const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
  assert.equal(store.verify(tampered), null);
});

test("malformed inputs return null instead of throwing", () => {
  const store = new TokenStore(undefined, Buffer.alloc(32, 1));
  assert.equal(store.verify(""), null);
  assert.equal(store.verify("short"), null);
  assert.equal(store.verify("x".repeat(600)), null);
});

test("digest stores only HMAC token ids, never raw tokens", () => {
  const store = new TokenStore(undefined, Buffer.alloc(32, 1));
  const { token } = store.issue("desk");
  const digest: StoredToken[] = store.digest();
  assert.equal(digest.length, 1);
  assert.match(digest[0].tokenId, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(digest).includes(token));
});

test("revokeClient and revokeAll invalidate verification", () => {
  const store = new TokenStore(undefined, Buffer.alloc(32, 1));
  const a = store.issue("a");
  const b = store.issue("b");
  assert.equal(store.revokeClient(a.clientId), 1);
  assert.equal(store.verify(a.token), null);
  assert.ok(store.verify(b.token));

  assert.equal(store.revokeAll(), 1);
  assert.equal(store.verify(b.token), null);
  assert.equal(store.revokeAll(), 0);
  assert.ok(store.listClients().every((c) => c.revoked));
});

test("persistence round-trip restores verification with the same secret", () => {
  let saved: StoredToken[] | null = null;
  const persistence = {
    load: () => saved,
    save: (tokens: StoredToken[]) => {
      saved = tokens;
    },
  };
  const secret = Buffer.alloc(32, 9);
  const first = new TokenStore(persistence, secret);
  const { token } = first.issue("persisted");

  const second = new TokenStore(persistence, secret);
  const meta = second.verify(token);
  assert.ok(meta);
  assert.equal(meta.name, "persisted");
});

test("restored records from a different secret do not verify", () => {
  let saved: StoredToken[] | null = null;
  const persistence = {
    load: () => saved,
    save: (tokens: StoredToken[]) => {
      saved = tokens;
    },
  };
  const first = new TokenStore(persistence, Buffer.alloc(32, 1));
  const { token } = first.issue("desk");
  const second = new TokenStore(persistence, Buffer.alloc(32, 2));
  assert.equal(second.verify(token), null);
});
