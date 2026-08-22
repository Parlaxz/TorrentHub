import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryRateLimiter } from "../../src/main/auth/index.js";

test("allows up to max hits inside the window then blocks with retry hint", () => {
  const now = 10_000;
  const limiter = new MemoryRateLimiter({ windowMs: 1_000, max: 2 }, () => now);
  assert.equal(limiter.take("k").ok, true);
  assert.equal(limiter.take("k").ok, true);
  const blocked = limiter.take("k");
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1_000);
});

test("hits expire once the sliding window passes", () => {
  let now = 10_000;
  const limiter = new MemoryRateLimiter({ windowMs: 1_000, max: 1 }, () => now);
  assert.equal(limiter.take("k").ok, true);
  assert.equal(limiter.take("k").ok, false);
  now += 1_001;
  assert.equal(limiter.take("k").ok, true);
});

test("keys are isolated", () => {
  const limiter = new MemoryRateLimiter({ windowMs: 1_000, max: 1 }, () => 0);
  assert.equal(limiter.take("a").ok, true);
  assert.equal(limiter.take("b").ok, true);
  assert.equal(limiter.take("a").ok, false);
});

test("reset clears all state", () => {
  const limiter = new MemoryRateLimiter({ windowMs: 60_000, max: 1 }, () => 0);
  limiter.take("a");
  limiter.reset();
  assert.equal(limiter.take("a").ok, true);
});
