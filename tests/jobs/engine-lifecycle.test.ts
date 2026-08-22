import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidTransitionError } from "../../src/main/jobs/index.ts";
import type { JobRecord } from "../../src/main/jobs/index.ts";
import { initialStageMap } from "../../src/main/jobs/index.ts";
import { fakeMetadata } from "./fakes.ts";
import { makeHarness, waitFor } from "./harness.ts";

const MAGNET = "magnet:?xt=urn:btih:abcdef";

test("duplicate idempotency key returns the same job", async () => {
  const h = makeHarness({ metadata: fakeMetadata(1, 300) });

  // Concurrent intake with the same key collapses to one metadata fetch.
  const [a, b] = await Promise.all([
    h.engine.createIntake(MAGNET, "client-key-1"),
    h.engine.createIntake(MAGNET, "client-key-1"),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(h.torrent.fetchMetadataCount, 1);

  // Sequential repeat also returns the same draft.
  const c = await h.engine.createIntake(MAGNET, "client-key-1");
  assert.equal(c.id, a.id);

  // Commit replay (lost HTTP response) returns the same started job.
  const started = await h.engine.commitSelection(a.id, [0], "start-key-9");
  const replayed = await h.engine.commitSelection(a.id, [0], "start-key-9");
  assert.equal(replayed.id, started.id);
  await h.engine.whenIdle();
  assert.equal(h.torrent.addTorrentCalls.length, 1, "no duplicate torrent for replayed Start");

  // A different job trying to claim the same commit key is redirected back.
  const other = await h.engine.createIntake(MAGNET);
  const redirected = await h.engine.commitSelection(other.id, [0], "start-key-9");
  assert.equal(redirected.id, started.id);
});

test("cancel during download deletes only the owned torrent + data", async () => {
  const h = makeHarness({
    metadata: fakeMetadata(2, 1000),
    telemetryScript: [
      { downloadedBytes: 100, selectedComplete: false, speedBps: 1000 },
    ], // last sample repeats: never completes
  });

  const draft = await h.engine.createIntake(MAGNET);
  const record = await h.engine.commitSelection(draft.id, [0, 1]);
  await waitFor(async () => ((await h.engine.getJob(record.id)).state === "downloading" ? true : null));

  await h.engine.cancel(record.id);
  await h.engine.whenIdle();

  const job = await h.engine.getJob(record.id);
  assert.equal(job.state, "cancelled");
  assert.ok(h.torrent.stopCount >= 1);
  assert.equal(h.torrent.deleteOwnedCalls.length, 1);
  assert.equal(h.torrent.deleteOwnedCalls[0].deleteData, true);
});

test("cancel of an intake draft discards it", async () => {
  const h = makeHarness({ metadata: fakeMetadata(1) });
  const draft = await h.engine.createIntake(MAGNET);
  const cancelled = await h.engine.cancel(draft.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(h.torrent.addTorrentCalls.length, 0);
});

test("cancel during packaging aborts ZIP, deletes partial, preserves torrent by default", async () => {
  const h = makeHarness({
    metadata: fakeMetadata(2, 1000),
    packagingBehaviors: [
      {
        hangUntil: (signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      },
    ],
  });

  const draft = await h.engine.createIntake(MAGNET);
  const record = await h.engine.commitSelection(draft.id, [0, 1]);
  await waitFor(async () => ((await h.engine.getJob(record.id)).state === "packaging" ? true : null));

  await h.engine.cancel(record.id); // cleanup NOT requested
  await h.engine.whenIdle();

  const job = await h.engine.getJob(record.id);
  assert.equal(job.state, "cancelled");
  assert.ok(
    h.workspace.removed.includes(h.packaging.createZipCalls[0].outputZipPath),
    "partial ZIP deleted",
  );
  assert.equal(h.torrent.deleteOwnedCalls.length, 0, "torrent preserved when cleanup not requested");
});

test("full cancellation during upload removes local artifacts and owned torrent", async () => {
  const h = makeHarness({ metadata: fakeMetadata(2, 1000) });
  // Hanging upload aborted cooperatively via the request's AbortSignal.
  h.viking.upload = (request) =>
    new Promise((_resolve, reject) => {
      request.abort.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });

  const draft = await h.engine.createIntake(MAGNET);
  const record = await h.engine.commitSelection(draft.id, [0, 1]);
  await waitFor(async () => ((await h.engine.getJob(record.id)).state === "uploading" ? true : null));

  await h.engine.cancel(record.id, { cleanup: true });
  await h.engine.whenIdle();

  const job = await h.engine.getJob(record.id);
  assert.equal(job.state, "cancelled");
  assert.equal(h.torrent.deleteOwnedCalls.length, 1, "owned torrent+data removed on full cancel");
  assert.equal(h.torrent.deleteOwnedCalls[0].deleteData, true);
});

test("stale nonterminal previous-session job becomes interrupted, not resumed", async () => {
  const h = makeHarness({ metadata: fakeMetadata(2, 1000) });

  const stale: JobRecord = {
    id: "stale-job",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 30_000).toISOString(),
    state: "downloading",
    source: { kind: "magnet", value: MAGNET },
    selection: [0, 1],
    selectedBytes: 2000,
    zipRequired: true,
    stages: initialStageMap(),
    sessionEpoch: "previous-session",
  };
  stale.stages.download = "active";
  h.repo.seed(stale);

  const marked = await h.engine.startupSweep();

  assert.equal(marked, 1);
  const job = await h.engine.getJob("stale-job");
  assert.equal(job.state, "interrupted");
  assert.equal(job.lastKnownStage, "download");
  assert.equal(h.torrent.addTorrentCalls.length, 0, "must not inspect/reconstruct qBittorrent");
  assert.equal(h.torrent.fetchMetadataCount, 0);
  assert.equal(h.packaging.createZipCalls.length, 0, "must not resume ZIP");
  assert.equal(h.viking.uploadCalls.length, 0, "must not resume upload");

  // Current-session nonterminal jobs are left alone.
  await h.engine.createIntake(MAGNET);
  assert.equal(await h.engine.startupSweep(), 0);
  const draft = (await h.engine.listJobs()).find((j) => j.state === "awaiting_selection");
  assert.ok(draft, "current-session draft untouched");
});

test("V1 concurrency: second transfer rejected while one is active", async () => {
  const h = makeHarness({
    metadata: fakeMetadata(1, 500),
    telemetryScript: [{ downloadedBytes: 10, selectedComplete: false, speedBps: 100 }],
  });

  const first = await h.engine.createIntake(MAGNET);
  await h.engine.commitSelection(first.id, [0]);
  await waitFor(async () => ((await h.engine.getJob(first.id)).state === "downloading" ? true : null));

  const second = await h.engine.createIntake(MAGNET);
  await assert.rejects(
    () => h.engine.commitSelection(second.id, [0]),
    (error: unknown) => {
      assert.ok(error instanceof InvalidTransitionError);
      assert.match(error.message, /another transfer is active/);
      return true;
    },
  );

  await h.engine.cancel(first.id);
  await h.engine.whenIdle();
});
