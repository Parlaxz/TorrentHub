import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeMetadata, joinPosix } from "./fakes.ts";
import { makeHarness } from "./harness.ts";

const MAGNET = "magnet:?xt=urn:btih:abcdef";

test("successful one-file direct path (packaging skipped)", async () => {
  const h = makeHarness({
    metadata: fakeMetadata(1, 500),
    telemetryScript: [
      { downloadedBytes: 0, selectedComplete: false },
      { downloadedBytes: 500, selectedComplete: true, speedBps: 10_000, seeds: 2, peers: 4 },
    ],
  });

  const draft = await h.engine.createIntake(MAGNET);
  assert.equal(draft.state, "awaiting_selection");
  assert.equal(draft.metadata?.files.length, 1);

  const record = await h.engine.commitSelection(draft.id, [0]);
  await h.engine.whenIdle();

  const job = await h.engine.getJob(record.id);
  assert.equal(job.state, "complete");
  assert.equal(job.zipRequired, false);
  assert.equal(job.stages.packaging, "skipped");
  assert.equal(job.directSourcePath, joinPosix(job.downloadDir!, "folder/file0.bin"));
  assert.equal(h.viking.uploadCalls.length, 1);
  assert.equal(h.viking.uploadCalls[0].filePath, job.directSourcePath);
  assert.equal(h.packaging.createZipCalls.length, 0);
  assert.equal(h.torrent.deleteOwnedCalls.length, 1);
  assert.equal(h.torrent.deleteOwnedCalls[0].deleteData, true);
  assert.ok(job.result?.url);
  assert.equal(job.result?.cleanupWarning ?? null, null);
});

test("successful multifile ZIP path", async () => {
  const h = makeHarness({
    metadata: fakeMetadata(2, 1000),
    telemetryScript: [
      { downloadedBytes: 500, selectedComplete: false, speedBps: 20_000 },
      { downloadedBytes: 2000, selectedComplete: true, speedBps: 20_000 },
    ],
  });

  const draft = await h.engine.createIntake(MAGNET);
  const record = await h.engine.commitSelection(draft.id, [1, 0]);
  await h.engine.whenIdle();

  const job = await h.engine.getJob(record.id);
  assert.equal(job.state, "complete");
  assert.equal(job.zipRequired, true);
  assert.deepEqual(job.selection, [0, 1]);
  assert.equal(h.packaging.createZipCalls.length, 1);
  const zipCall = h.packaging.createZipCalls[0];
  // Inputs ordered by selection index and pointing at completed files.
  // B1: explicit entries carry torrent-relative archive paths + declared sizes.
  assert.deepEqual(
    zipCall.entries.map((e) => e.absoluteSourcePath),
    [
      joinPosix(job.downloadDir!, "folder/file0.bin"),
      joinPosix(job.downloadDir!, "folder/file1.bin"),
    ],
  );
  assert.deepEqual(
    zipCall.entries.map((e) => e.archiveRelativePath),
    ["folder/file0.bin", "folder/file1.bin"],
  );
  assert.deepEqual(zipCall.entries.map((e) => e.sizeBytes), [1000, 1000]);
  assert.deepEqual(zipCall.entries.map((e) => e.torrentFileIndex), [0, 1]);
  assert.ok(zipCall.outputZipPath.startsWith(job.packageDir!));
  assert.equal(h.viking.uploadCalls[0].filePath, zipCall.outputZipPath);
  // ZIP deleted during cleanup; owned torrent deleted with data.
  assert.ok(h.workspace.removed.includes(zipCall.outputZipPath));
  assert.equal(h.torrent.deleteOwnedCalls.length, 1);
  assert.equal(h.torrent.deleteOwnedCalls[0].deleteData, true);
  assert.equal(job.result?.url, "https://viking.example/file");
});

test("final URL persisted before destructive cleanup call", async () => {
  const h = makeHarness();
  const draft = await h.engine.createIntake(MAGNET);
  const record = await h.engine.commitSelection(draft.id, [0, 1]);
  await h.engine.whenIdle();

  const urlSaveIndex = h.events.findIndex((e) => e.endsWith(":url"));
  const cleanupIndex = h.events.findIndex((e) => e.startsWith("delete-owned"));
  assert.ok(urlSaveIndex >= 0, "result URL was never persisted");
  assert.ok(cleanupIndex >= 0, "cleanup never ran");
  assert.ok(
    urlSaveIndex < cleanupIndex,
    `URL must be persisted before cleanup (save@${urlSaveIndex}, cleanup@${cleanupIndex})`,
  );
  void record;
});

test("cleanup failure keeps successful result with warning", async () => {
  const h = makeHarness();
  h.torrent.deleteOwnedShouldThrow = new Error("qbit refused delete");

  const draft = await h.engine.createIntake(MAGNET);
  const record = await h.engine.commitSelection(draft.id, [0, 1]);
  await h.engine.whenIdle();

  const job = await h.engine.getJob(record.id);
  assert.equal(job.state, "complete", "cleanup failure must NOT downgrade to failed");
  assert.ok(job.result?.url);
  assert.match(job.result.cleanupWarning ?? "", /qbit refused delete/);
  assert.equal(job.stages.cleanup, "failed");
  assert.equal(job.stages.finalize, "complete");
});

test("zero seeds / zero speed does not fail the job", async () => {
  const h = makeHarness({
    metadata: fakeMetadata(1, 400),
    telemetryScript: [
      { downloadedBytes: 0, selectedComplete: false, speedBps: 0, seeds: 0, peers: 0 },
      { downloadedBytes: 0, selectedComplete: false, speedBps: 0, seeds: 0, peers: 1 },
      { downloadedBytes: 200, selectedComplete: false, speedBps: 0, seeds: 0, peers: 2 },
      { downloadedBytes: 400, selectedComplete: true, speedBps: 30_000, seeds: 1, peers: 3 },
    ],
  });

  const draft = await h.engine.createIntake(MAGNET);
  const record = await h.engine.commitSelection(draft.id, [0]);
  await h.engine.whenIdle();

  const job = await h.engine.getJob(record.id);
  assert.equal(job.state, "complete");
  assert.equal(job.error, null);
});
