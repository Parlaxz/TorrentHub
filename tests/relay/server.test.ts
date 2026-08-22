import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthController } from "../../src/main/auth/index.js";
import type { RelaySnapshot } from "../../src/main/relay/lifecycle.js";
import {
  bearer,
  buildTestApp,
  pairClient,
  type TestAppResult,
} from "./helpers.js";

const MAGNET = "magnet:?xt=urn:btih:abcdef1234567890";

async function fresh(opts?: Parameters<typeof buildTestApp>[0]): Promise<TestAppResult> {
  return buildTestApp(opts);
}

test("health is open and minimal", async () => {
  const { app } = await fresh();
  const res = await app.inject({ method: "GET", url: "/v1/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test("pairing happy path returns raw token exactly once", async () => {
  const { app, auth } = await fresh();
  const { code } = auth.beginPairing();

  const first = await app.inject({
    method: "POST",
    url: "/v1/pair",
    payload: { code, name: "lab-pc" },
  });
  assert.equal(first.statusCode, 200);
  const body = first.json();
  assert.match(body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(body.clientId, /^vrc_[0-9a-f]{16}$/);
  assert.equal(body.name, "lab-pc");

  const replay = await app.inject({
    method: "POST",
    url: "/v1/pair",
    payload: { code },
  });
  assert.equal(replay.statusCode, 400);
  assert.equal(replay.json().error, "invalid_code");
});

test("wrong and expired pairing codes are rejected over http", async () => {
  let now = 5_000_000;
  const { app, auth } = await fresh({
    auth: new AuthController({ pairing: { ttlMs: 100, now: () => now } }),
  });

  const wrong = await app.inject({
    method: "POST",
    url: "/v1/pair",
    payload: { code: "QQQQ2222" },
  });
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.json().error, "invalid_code");

  const { code } = auth.beginPairing();
  now += 101;
  const expired = await app.inject({
    method: "POST",
    url: "/v1/pair",
    payload: { code },
  });
  assert.equal(expired.statusCode, 410);
  assert.equal(expired.json().error, "expired_code");
});

test("pair attempts are rate limited with retry-after", async () => {
  const { app } = await fresh({
    auth: new AuthController({
      pairing: { attemptsPerWindowPerIp: 2, attemptsWindowMs: 60_000 },
    }),
  });
  for (let i = 0; i < 2; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: "XXXXYYYY" },
    });
    assert.equal(res.statusCode, 400);
  }
  const limited = await app.inject({
    method: "POST",
    url: "/v1/pair",
    payload: { code: "XXXXYYYY" },
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error, "rate_limited");
  assert.ok(limited.headers["retry-after"]);
});

test("protected endpoints require a valid bearer token", async () => {
  const { app, auth } = await fresh();
  const missing = await app.inject({ method: "GET", url: "/v1/jobs" });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json().error, "unauthorized");
  assert.equal(missing.headers["www-authenticate"], "Bearer");

  const garbage = await app.inject({
    method: "GET",
    url: "/v1/jobs",
    headers: bearer("totally-invalid-token-value-000000"),
  });
  assert.equal(garbage.statusCode, 401);

  const token = await pairClient(app, auth);
  const ok = await app.inject({
    method: "GET",
    url: "/v1/jobs",
    headers: bearer(token),
  });
  assert.equal(ok.statusCode, 200);

  const clients = auth.listClients();
  auth.revokeClient(clients[0].clientId);
  const revoked = await app.inject({
    method: "GET",
    url: "/v1/jobs",
    headers: bearer(token),
  });
  assert.equal(revoked.statusCode, 401);
});

test("authorization headers and tokens never reach structured logs", async () => {
  const { app, auth, logs } = await fresh({ captureLogs: true });

  const leaked = "SECRETTOKENVALUE1234567890abcdefg";
  await app.inject({
    method: "GET",
    url: "/v1/jobs",
    headers: bearer(leaked),
  });

  const token = await pairClient(app, auth, "loggy");
  await app.inject({
    method: "GET",
    url: "/v1/jobs",
    headers: bearer(token),
  });

  const joined = logs.join("");
  assert.ok(joined.includes("[REDACTED]"), "expected redaction marker in logs");
  assert.ok(!joined.includes(leaked), "bearer secret leaked into logs");
  assert.ok(!joined.includes(token), "paired token leaked into logs");
});

test("routes delegate to the injected job service", async () => {
  const { app, jobs, auth } = await fresh();
  const token = bearer(await pairClient(app, auth));

  const intakeRes = await app.inject({
    method: "POST",
    url: "/v1/intakes",
    headers: token,
    payload: { source: { kind: "magnet", value: MAGNET } },
  });
  assert.equal(intakeRes.statusCode, 201);
  const intake = intakeRes.json();
  assert.match(intake.id, /^intake_\d+$/);
  assert.equal(jobs.calls[0].method, "createIntake");

  const getIntake = await app.inject({
    method: "GET",
    url: `/v1/intakes/${intake.id}`,
    headers: token,
  });
  assert.equal(getIntake.statusCode, 200);
  assert.equal(getIntake.json().id, intake.id);

  const jobRes = await app.inject({
    method: "POST",
    url: "/v1/jobs",
    headers: token,
    payload: { intakeId: intake.id, selection: [0, 2], zipRequired: true },
  });
  assert.equal(jobRes.statusCode, 201);
  const job = jobRes.json();
  assert.match(job.id, /^job_\d+$/);

  const listRes = await app.inject({ method: "GET", url: "/v1/jobs", headers: token });
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.json().jobs.length, 1);

  const getJob = await app.inject({
    method: "GET",
    url: `/v1/jobs/${job.id}`,
    headers: token,
  });
  assert.equal(getJob.statusCode, 200);
  assert.equal(getJob.json().id, job.id);

  const cancel = await app.inject({
    method: "POST",
    url: `/v1/jobs/${job.id}/cancel`,
    headers: token,
  });
  assert.equal(cancel.statusCode, 200);
  assert.equal(cancel.json().state, "cancelled");

  const retryPackaging = await app.inject({
    method: "POST",
    url: `/v1/jobs/${job.id}/retry-packaging`,
    headers: token,
  });
  assert.equal(retryPackaging.json().state, "packaging");

  const retryUpload = await app.inject({
    method: "POST",
    url: `/v1/jobs/${job.id}/retry-upload`,
    headers: token,
  });
  assert.equal(retryUpload.json().state, "uploading");

  const recheck = await app.inject({
    method: "POST",
    url: `/v1/jobs/${job.id}/recheck-storage`,
    headers: token,
  });
  assert.equal(recheck.statusCode, 200);

  const history = await app.inject({
    method: "GET",
    url: "/v1/history?limit=5",
    headers: token,
  });
  assert.equal(history.statusCode, 200);
  assert.ok(Array.isArray(history.json().history));
  const historyCall = jobs.calls.find((c) => c.method === "listHistory");
  assert.equal(historyCall?.args, 5);

  const methods = jobs.calls.map((c) => c.method);
  for (const expected of [
    "getIntake",
    "createJob",
    "listJobs",
    "getJob",
    "cancelJob",
    "retryPackaging",
    "retryUpload",
    "recheckStorage",
  ]) {
    assert.ok(methods.includes(expected), `missing delegation to ${expected}`);
  }
});

test("idempotency keys pass through with header precedence", async () => {
  const { app, jobs, auth } = await fresh();
  const token = bearer(await pairClient(app, auth));

  await app.inject({
    method: "POST",
    url: "/v1/jobs",
    headers: { ...token, "idempotency-key": "hdr-key-1" },
    payload: { intakeId: "intake_1", idempotencyKey: "body-key-1" },
  });
  await app.inject({
    method: "POST",
    url: "/v1/jobs",
    headers: token,
    payload: { intakeId: "intake_1", idempotencyKey: "body-key-2" },
  });
  await app.inject({
    method: "POST",
    url: "/v1/intakes",
    headers: token,
    payload: { source: { kind: "url", value: "https://example.com/a.torrent" } },
  });

  const createCalls = jobs.calls.filter((c) => c.method === "createJob");
  assert.equal(createCalls[0].args.idempotencyKey, "hdr-key-1");
  assert.equal(createCalls[1].args.idempotencyKey, "body-key-2");
  const intakeCall = jobs.calls.find((c) => c.method === "createIntake");
  assert.equal(intakeCall?.args.idempotencyKey, null);
});

test("validation rejects bad sources, shapes, and unknown fields", async () => {
  const { app, auth } = await fresh();
  const token = bearer(await pairClient(app, auth));

  const cases: Array<{ payload: unknown; path?: string }> = [
    { payload: { source: { kind: "magnet", value: "http://example.com/x" } }, path: "source.value" },
    { payload: { source: { kind: "url", value: "ftp://example.com/x" } } },
    { payload: { source: { kind: "torrent", value: "x" } } },
    { payload: { source: { kind: "magnet", value: MAGNET }, rogue: true } },
    { payload: { intakeId: "intake_1", selection: [1.5] } },
    { payload: {} },
  ];
  for (const [i, testCase] of cases.entries()) {
    const res = await app.inject({
      method: "POST",
      url: i < 4 ? "/v1/intakes" : "/v1/jobs",
      headers: token,
      payload: testCase.payload as Record<string, unknown>,
    });
    assert.equal(res.statusCode, 400, `case ${i}: ${JSON.stringify(testCase.payload)}`);
    assert.equal(res.json().error, "validation_error");
  }

  const badCode = await app.inject({
    method: "POST",
    url: "/v1/pair",
    payload: { code: "nope" },
  });
  assert.equal(badCode.statusCode, 400);
  assert.equal(badCode.json().error, "validation_error");
});

test("oversized payloads are rejected without processing", async () => {
  const { app, auth } = await fresh({ bodyLimit: 256 });
  const token = bearer(await pairClient(app, auth));
  const big = "x".repeat(1024);
  const res = await app.inject({
    method: "POST",
    url: "/v1/intakes",
    headers: token,
    payload: { source: { kind: "magnet", value: `magnet:?xt=urn:btih:${big}` } },
  });
  assert.equal(res.statusCode, 413);
  assert.equal(res.json().error, "payload_too_large");
});

test("unknown routes and missing jobs map to clean errors", async () => {
  const { app, auth } = await fresh();
  const token = bearer(await pairClient(app, auth));

  const notFound = await app.inject({ method: "GET", url: "/v1/nope", headers: token });
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.json().error, "not_found");

  const missingJob = await app.inject({
    method: "GET",
    url: "/v1/jobs/job_missing",
    headers: token,
  });
  assert.equal(missingJob.statusCode, 404);
  assert.equal(missingJob.json().error, "job_not_found");

  const badId = await app.inject({
    method: "GET",
    url: "/v1/jobs/../../etc",
    headers: token,
  });
  assert.ok([400, 404].includes(badId.statusCode));
});

test("server status exposes transport snapshot without secrets", async () => {
  const snapshot: RelaySnapshot = {
    state: "listening",
    host: "26.10.40.7",
    port: 47821,
    adapterName: "Radmin VPN",
    address: "26.10.40.7",
    bindError: null,
    candidates: [{ adapterName: "Radmin VPN", address: "26.10.40.7" }],
    updatedAt: new Date().toISOString(),
  };
  const { app, auth } = await fresh({ transportSnapshot: () => snapshot });
  const token = bearer(await pairClient(app, auth, "dash"));

  const res = await app.inject({
    method: "GET",
    url: "/v1/server/status",
    headers: token,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.transport.state, "listening");
  assert.equal(body.transport.address, "26.10.40.7");
  assert.equal(body.pairedClients, 1);
  assert.ok(!JSON.stringify(body).includes("token"));
});
