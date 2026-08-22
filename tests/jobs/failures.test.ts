import assert from "node:assert/strict";
import { test } from "node:test";
import { InsufficientSpaceError } from "../../src/main/jobs/index.ts";
import { fakeMetadata } from "./fakes.ts";
import { makeHarness } from "./harness.ts";

const MAGNET = "magnet:?xt=urn:btih:abcdef";

test("start blocked when preflight reports insufficient disk", async () => {
  const h = makeHarness({ metadata: fakeMetadata(2, 1000) });
  h.storage.preflightOk = false;

  const draft = await h.engine.createIntake(MAGNET);
  await assert.rejects(
    () => h.engine.commitSelection(draft.id, [0, 1]),
    (error: unknown) => {
      assert.ok(error instanceof InsufficientSpaceError);
      return true;
    },
  );

  const job = await h.engine.getJob(draft.id);
  assert.equal(job.state, "awaiting_selection", "Start rejected; job stays awaiting selection");
  assert.equal(job.error?.kind, "storage_preflight");
  assert.equal(job.error?.insufficientSpace, true);
  assert.equal(h.torrent.addTorrentCalls.length, 0, "no torrent added on rejected Start");
  assert.equal(h.workspace.createdDirs.size, 0, "no job dirs created on rejected Start");

  // Retry Start after space frees up succeeds end to end.
  h.storage.preflightOk = true;
  await h.engine.commitSelection(draft.id, [0, 1]);
  await h.engine.whenIdle();
  assert.equal((await h.engine.getJob(draft.id)).state, "complete");
});

test("storage becomes insufficient before packaging -> specific failure + retry-storage-check", async () => {
  // Readings: tick1 big, tick2 big, packaging gate small.
  const h = makeHarness({
    metadata: fakeMetadata(2, 1000),
    storageFreeReadings: [1_000_000_000, 1_000_000_000, 100],
  });

  const draft = await h.engine.createIntake(MAGNET);
  const record = await h.engine.commitSelection(draft.id, [0, 1]);
  await h.engine.whenIdle();

  let job = await h.engine.getJob(record.id);
  assert.equal(job.state, "failed");
  assert.equal(job.error?.kind, "storage_before_packaging");
  assert.equal(job.error?.insufficientSpace, true);
  assert.equal(h.packaging.createZipCalls.length, 0, "ZIP must not begin");
  assert.equal(h.torrent.deleteOwnedCalls.length, 0, "completed download preserved");

  // Space freed: retry the storage check and continue without redownloading.
  h.storage.freeReadings = [1_000_000_000];
  await h.engine.retryStorageCheck(record.id);

  job = await h.engine.getJob(record.id);
  assert.equal(job.state, "complete");
  assert.equal(h.torrent.addTorrentCalls.length, 1, "no re-download after storage retry");
  assert.equal(h.packaging.createZipCalls.length, 1);
  assert.equal(h.viking.uploadCalls.length, 1);
});

test("packaging failure retains download and retryPackaging completes", async () => {
  const h = makeHarness({
    metadata: fakeMetadata(2, 1000),
    packagingBehaviors: [new Error("zip boom"), { sizeBytes: 1234 }],
  });

  const draft = await h.engine.createIntake(MAGNET);
  const record = await h.engine.commitSelection(draft.id, [0, 1]);
  await h.engine.whenIdle();

  let job = await h.engine.getJob(record.id);
  assert.equal(job.state, "failed");
  assert.equal(job.error?.kind, "packaging");
  assert.equal(h.torrent.deleteOwnedCalls.length, 0, "download retained on packaging failure");
  assert.ok(
    h.workspace.removed.includes(h.packaging.createZipCalls[0].outputZipPath),
    "partial ZIP removed",
  );

  // Prerequisites still valid: completed files exist.
  for (const f of job.completedFiles ?? []) h.workspace.existing.add(f.absolutePath);

  await h.engine.retryPackaging(record.id);

  job = await h.engine.getJob(record.id);
  assert.equal(job.state, "complete");
  assert.equal(h.packaging.createZipCalls.length, 2);
  assert.equal(h.torrent.addTorrentCalls.length, 1, "retry must not redownload");
  assert.equal(h.viking.uploadCalls.length, 1);
  assert.equal(h.torrent.deleteOwnedCalls.length, 1, "owned torrent deleted only at final cleanup");
});

test("upload failure retains source and retryUpload skips repackaging", async () => {
  const h = makeHarness({
    metadata: fakeMetadata(2, 1000),
    vikingBehaviors: [new Error("viking 503"), { url: "https://viking.example/ok" }],
  });

  const draft = await h.engine.createIntake(MAGNET);
  const record = await h.engine.commitSelection(draft.id, [0, 1]);
  await h.engine.whenIdle();

  let job = await h.engine.getJob(record.id);
  assert.equal(job.state, "failed");
  assert.equal(job.error?.kind, "upload");
  assert.ok(job.zipPath, "package retained");
  assert.ok(!h.workspace.removed.includes(job.zipPath!), "ZIP not cleaned up while upload failing");
  assert.equal(h.packaging.createZipCalls.length, 1);

  await h.engine.retryUpload(record.id);

  job = await h.engine.getJob(record.id);
  assert.equal(job.state, "complete");
  assert.equal(h.viking.uploadCalls.length, 2);
  assert.equal(h.packaging.createZipCalls.length, 1, "retry upload must NOT repackage");
  assert.equal(h.torrent.addTorrentCalls.length, 1, "retry upload must NOT redownload");
});
