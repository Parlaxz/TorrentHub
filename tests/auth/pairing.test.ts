import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PAIRING_CODE_ALPHABET,
  PairingService,
  TokenStore,
} from "../../src/main/auth/index.js";

function makeTokens(): TokenStore {
  return new TokenStore(undefined, Buffer.alloc(32, 7));
}

test("beginPairing produces readable uppercase codes from the safe alphabet", () => {
  const service = new PairingService(makeTokens());
  for (let i = 0; i < 50; i++) {
    const { code, expiresAt } = service.beginPairing();
    assert.equal(code.length, 8);
    for (const ch of code) {
      assert.ok(PAIRING_CODE_ALPHABET.includes(ch), `unexpected char ${ch}`);
      assert.ok(!"ILO01".includes(ch));
    }
    assert.ok(expiresAt > Date.now());
  }
});

test("pairing happy path issues a strong one-time bearer token", () => {
  const tokens = makeTokens();
  const service = new PairingService(tokens);
  const { code } = service.beginPairing();
  const result = service.attempt(code, "10.0.0.5", "lab-pc");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(result.issued.clientId, /^vrc_[0-9a-f]{16}$/);
  assert.equal(result.issued.name, "lab-pc");

  const replay = service.attempt(code, "10.0.0.5");
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.error, "invalid_code");
});

test("wrong code is rejected without revealing active code state", () => {
  const service = new PairingService(makeTokens());
  service.beginPairing();
  const result = service.attempt("ZZZZZZZZ", "10.0.0.6");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.equal(result.error, "invalid_code");
  }
});

test("expired code returns expired_code and is consumed", () => {
  let now = 1_000_000;
  const service = new PairingService(makeTokens(), { ttlMs: 1_000, now: () => now });
  const { code } = service.beginPairing();
  now += 1_001;
  const result = service.attempt(code, "10.0.0.7");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 410);
    assert.equal(result.error, "expired_code");
  }
  assert.equal(service.activeCount(), 0);
});

test("attempts are rate limited per ip and globally", () => {
  let now = 2_000_000;
  const service = new PairingService(makeTokens(), {
    attemptsPerWindowPerIp: 3,
    globalAttemptsPerWindow: 5,
    attemptsWindowMs: 60_000,
    now: () => now,
  });
  for (let i = 0; i < 3; i++) {
    const r = service.attempt("WRONGCOD", "10.9.9.9");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "invalid_code");
  }
  const limited = service.attempt("WRONGCOD", "10.9.9.9");
  assert.equal(limited.ok, false);
  if (!limited.ok) {
    assert.equal(limited.status, 429);
    assert.equal(limited.error, "rate_limited");
    assert.ok((limited.retryAfterMs ?? 0) > 0);
  }

  for (let i = 0; i < 2; i++) service.attempt("WRONGCOD", `10.9.9.${i}`);
  const globalLimited = service.attempt("WRONGCOD", "10.8.8.8");
  assert.equal(globalLimited.ok, false);
  if (!globalLimited.ok) assert.equal(globalLimited.error, "rate_limited");

  now += 61_000;
  const afterWindow = service.attempt("WRONGCOD", "10.9.9.9");
  assert.equal(afterWindow.ok, false);
  if (!afterWindow.ok) assert.equal(afterWindow.error, "invalid_code");
});

test("active pairing codes are capped and oldest evicted", () => {
  const service = new PairingService(makeTokens(), { maxActiveCodes: 2 });
  const first = service.beginPairing().code;
  service.beginPairing();
  service.beginPairing();
  assert.equal(service.activeCount(), 2);
  const result = service.attempt(first, "10.0.0.9");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "invalid_code");
});

test("pending codes are stored hashed, never in plaintext", () => {
  const service = new PairingService(makeTokens());
  const { code } = service.beginPairing();
  const pending = [...(service as unknown as { pending: Map<string, unknown> }).pending.keys()];
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0], code);
  assert.match(pending[0], /^[0-9a-f]{64}$/);
});

test("case-insensitive entry with surrounding whitespace still pairs", () => {
  const service = new PairingService(makeTokens());
  const { code } = service.beginPairing();
  const result = service.attempt(`  ${code.toLowerCase()}  `, "10.0.0.10");
  assert.equal(result.ok, true);
});
