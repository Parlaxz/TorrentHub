import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planWatchTick,
  RelayManager,
  type RelaySnapshot,
} from "../../src/main/relay/lifecycle.js";
import type { InterfaceMap } from "../../src/main/relay/adapters.js";
import { buildTestApp, FakeJobService, type TestAppResult } from "./helpers.js";

const SILENT = { info() {}, warn() {}, error() {} };

function radminMap(address: string): InterfaceMap {
  return { "Radmin VPN": [{ address, family: "IPv4", internal: false }] };
}

async function buildSilentApp(): Promise<TestAppResult["app"]> {
  const { app } = await buildTestApp();
  return app;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("planWatchTick covers loss, address change, and return", () => {
  const listening = {
    state: "listening" as const,
    adapterName: "Radmin VPN",
    address: "26.1.1.1",
  };
  assert.deepEqual(
    planWatchTick(listening, {
      selected: null,
      candidates: [],
      reason: "none",
    }),
    { action: "shutdown", cause: "adapter_lost" },
  );
  assert.deepEqual(
    planWatchTick(listening, {
      selected: { adapterName: "Radmin VPN", address: "26.9.9.9" },
      candidates: [{ adapterName: "Radmin VPN", address: "26.9.9.9" }],
      reason: "adapter_name_match",
    }),
    { action: "rebind", address: "26.9.9.9", cause: "adapter_address_changed" },
  );
  assert.deepEqual(
    planWatchTick(listening, {
      selected: { adapterName: "Radmin VPN", address: "26.1.1.1" },
      candidates: [{ adapterName: "Radmin VPN", address: "26.1.1.1" }],
      reason: "adapter_name_match",
    }),
    { action: "keep" },
  );

  const unavailable = { ...listening, state: "unavailable" as const };
  assert.deepEqual(
    planWatchTick(unavailable, {
      selected: { adapterName: "Radmin VPN", address: "26.2.2.2" },
      candidates: [{ adapterName: "Radmin VPN", address: "26.2.2.2" }],
      reason: "adapter_name_match",
    }),
    { action: "rebind", address: "26.2.2.2", cause: "adapter_returned" },
  );

  const noAdapter = { ...listening, adapterName: null, address: null };
  assert.deepEqual(
    planWatchTick(noAdapter, {
      selected: { adapterName: "Radmin VPN", address: "26.1.1.1" },
      candidates: [],
      reason: "none",
    }),
    { action: "keep" },
  );
});

test("start binds only the selected radmin ipv4 and serves health", async () => {
  let map: InterfaceMap = radminMap("127.0.0.1");
  const manager = new RelayManager({
    port: 0,
    pollIntervalMs: 25,
    enumerate: () => map,
    buildApp: buildSilentApp,
    logger: SILENT,
  });
  try {
    const snap = await manager.start();
    assert.equal(snap.state, "listening");
    assert.equal(snap.host, "127.0.0.1");
    assert.ok((snap.port ?? 0) > 0);
    assert.equal(snap.adapterName, "Radmin VPN");
    assert.equal(snap.bindError, null);

    const res = await fetch(`http://127.0.0.1:${snap.port}/v1/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    map = {};
    await waitFor(() => manager.snapshot().state === "unavailable");
    assert.equal(manager.snapshot().bindError, "radmin_adapter_lost");
    await assert.rejects(fetch(`http://127.0.0.1:${snap.port}/v1/health`));

    map = radminMap("127.0.0.1");
    await waitFor(() => manager.snapshot().state === "listening");
    const back = await fetch(`http://127.0.0.1:${manager.snapshot().port}/v1/health`);
    assert.equal(back.status, 200);
  } finally {
    await manager.stop();
  }
  assert.equal(manager.snapshot().state, "stopped");
});

test("never falls back to other adapters or 0.0.0.0 when radmin is absent", async () => {
  let map: InterfaceMap = {
    "Wi-Fi": [{ address: "192.168.1.20", family: "IPv4", internal: false }],
  };
  const manager = new RelayManager({
    port: 0,
    pollIntervalMs: 25,
    enumerate: () => map,
    buildApp: buildSilentApp,
    logger: SILENT,
  });
  try {
    const snap = await manager.start();
    assert.equal(snap.state, "unavailable");
    assert.equal(snap.host, null);
    assert.equal(snap.port, null);
    assert.equal(snap.bindError, "radmin_adapter_not_detected");
    assert.notEqual(snap.state, "listening");

    map = { "Radmin VPN": [{ address: "0.0.0.0", family: "IPv4", internal: false }] };
    await manager.rebind();
    const zeroSnap = manager.snapshot();
    assert.notEqual(zeroSnap.state, "listening");
    assert.notEqual(zeroSnap.host, "0.0.0.0");
  } finally {
    await manager.stop();
  }
});

test("rebind restarts on an explicit safe address and rejects unknown ones", async () => {
  const map: InterfaceMap = radminMap("127.0.0.1");
  const manager = new RelayManager({
    port: 0,
    pollIntervalMs: 0,
    enumerate: () => map,
    buildApp: buildSilentApp,
    logger: SILENT,
  });
  try {
    await manager.start();
    assert.equal(manager.snapshot().state, "listening");

    const bad = await manager.rebind({ address: "203.0.113.99" });
    assert.equal(bad.state, "unavailable");
    assert.equal(bad.bindError, "override_address_not_found");

    const good = await manager.rebind({ address: "127.0.0.1" });
    assert.equal(good.state, "listening");
    assert.equal(good.host, "127.0.0.1");

    const cleared = await manager.rebind({ address: null });
    assert.equal(cleared.state, "listening");
  } finally {
    await manager.stop();
  }
});

test("transport lifecycle is independent of job service", async () => {
  const jobs = new FakeJobService();
  const { app } = await buildTestApp({ jobs });
  const snapshots: RelaySnapshot[] = [];
  const manager = new RelayManager({
    port: 0,
    pollIntervalMs: 0,
    enumerate: () => radminMap("127.0.0.1"),
    buildApp: () => Promise.resolve(app),
    logger: SILENT,
  });
  manager.onChange((s) => snapshots.push(s));
  try {
    await manager.start();
    assert.equal(manager.snapshot().state, "listening");
    assert.equal(jobs.calls.length, 0);
    await manager.stop();
    assert.equal(manager.snapshot().state, "stopped");
    assert.ok(snapshots.length >= 2);
  } finally {
    await app.close().catch(() => {});
  }
});

test("adapter returning with a different address rebinds live", async () => {
  let map: InterfaceMap = { "Radmin VPN": [{ address: "127.0.0.1", family: "IPv4", internal: false }] };
  const manager = new RelayManager({
    port: 0,
    pollIntervalMs: 20,
    enumerate: () => map,
    buildApp: buildSilentApp,
    logger: SILENT,
  });
  try {
    await manager.start();
    assert.equal(manager.snapshot().state, "listening");
    map = {};
    await waitFor(() => manager.snapshot().state === "unavailable");
    map = { "Radmin VPN": [{ address: "127.0.0.2", family: "IPv4", internal: false }] };
    await waitFor(() => manager.snapshot().state === "listening");
    const snap = manager.snapshot();
    assert.equal(snap.address, "127.0.0.2");
    assert.notEqual(snap.port, null);
    const res = await fetch(`http://127.0.0.2:${snap.port}/v1/health`);
    assert.equal(res.status, 200);
  } finally {
    await manager.stop();
  }
});
