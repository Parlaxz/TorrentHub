import assert from "node:assert/strict";
import { test } from "node:test";
import { initialStageMap, type JobRecord } from "../../src/main/jobs/index.ts";
import { fakeMetadata } from "./fakes.ts";
import { makeHarness, waitFor } from "./harness.ts";

const MAGNET = "magnet:?xt=urn:btih:abcdef";

test("download-list goal stops after the download and keeps the files", async () => {
  const h = makeHarness({
    metadata: fakeMetadata(1, 500),
    telemetryScript: [{ downloadedBytes: 500, selectedComplete: true }],
  });

  const draft = await h.engine.createIntake(MAGNET);
  const record = await h.engine.commitSelection(draft.id, [0], undefined, undefined, "download");
  await h.engine.whenIdle();

  const job = await h.engine.getJob(record.id);
  assert.equal(job.goal, "download");
  assert.equal(job.state, "complete");
  assert.equal(job.stages.packaging, "skipped");
  assert.equal(job.stages.upload, "skipped");
  assert.equal(h.packaging.createZipCalls.length, 0);
  assert.equal(h.viking.uploadCalls.length, 0);
  assert.equal(h.torrent.deleteOwnedCalls.length, 0, "parked files stay on disk");
  assert.equal(h.workspace.removed.length, 0);
  assert.ok(job.completedFiles?.length === 1);
});

test("discardDownload deletes the parked files and archives the job", async () => {
  const h = makeHarness({
    metadata: fakeMetadata(1, 500),
    telemetryScript: [{ downloadedBytes: 500, selectedComplete: true }],
  });

  const draft = await h.engine.createIntake(MAGNET);
  const record = await h.engine.commitSelection(draft.id, [0], undefined, undefined, "download");
  await h.engine.whenIdle();

  const discarded = await h.engine.discardDownload(record.id);
  assert.equal(discarded.archived, true);
  assert.equal(h.torrent.deleteOwnedCalls.length, 1);
  assert.equal(h.torrent.deleteOwnedCalls[0].deleteData, true);
  assert.ok(h.workspace.removed.includes(record.jobDir!));
});

test("a bundle order packages finished downloads into one ZIP and uploads it", async () => {
  const h = makeHarness({
    metadata: fakeMetadata(1, 500),
    telemetryScript: [{ downloadedBytes: 500, selectedComplete: true }],
  });

  const firstDraft = await h.engine.createIntake(MAGNET);
  const first = await h.engine.commitSelection(firstDraft.id, [0], undefined, undefined, "download");
  const secondDraft = await h.engine.createIntake(MAGNET);
  const second = await h.engine.commitSelection(secondDraft.id, [0], undefined, undefined, "download");
  await h.engine.whenIdle();

  const preflight = await h.engine.preflightOrder([first.id, second.id]);
  assert.equal(preflight.selectedFiles, 2);
  assert.equal(preflight.selectedBytes, 1000);

  const order = await h.engine.createOrder([first.id, second.id], null, {
    deleteTorrent: true,
    deleteFiles: true,
    deleteZip: true,
  });
  await h.engine.whenIdle();

  const done = await h.engine.getJob(order.id);
  assert.equal(done.state, "complete");
  assert.equal(done.source.kind, "bundle");
  assert.deepEqual(done.bundleJobIds, [first.id, second.id]);
  assert.equal(h.viking.uploadCalls.length, 1);
  assert.equal(h.packaging.createZipCalls.length, 1);
  assert.deepEqual(
    h.packaging.createZipCalls[0].entries.map((e) => e.archiveRelativePath),
    ["My Torrent/folder/file0.bin", "My Torrent (2)/folder/file0.bin"],
  );

  const firstAfter = await h.engine.getJob(first.id);
  const secondAfter = await h.engine.getJob(second.id);
  assert.equal(firstAfter.orderedByJobId, order.id);
  assert.equal(secondAfter.orderedByJobId, order.id);
  // Both source torrents deleted with their data.
  assert.equal(h.torrent.deleteOwnedCalls.length, 2);
  assert.ok(h.torrent.deleteOwnedCalls.every((call) => call.deleteData));
  assert.ok(h.workspace.removed.includes(first.jobDir!));
  assert.ok(h.workspace.removed.includes(second.jobDir!));
});

test("dismiss archives an order", async () => {
  const h = makeHarness({
    metadata: fakeMetadata(1, 500),
    telemetryScript: [{ downloadedBytes: 500, selectedComplete: true }],
  });

  const draft = await h.engine.createIntake(MAGNET);
  const order = await h.engine.commitSelection(draft.id, [0]);
  await h.engine.whenIdle();

  const dismissed = await h.engine.dismiss(order.id);
  assert.equal(dismissed.archived, true);
});

test("an order queues while its source download is still in progress", async () => {
  const h = makeHarness({ metadata: fakeMetadata(1, 500) });
  const now = new Date().toISOString();
  const source: JobRecord = {
    id: "dl-waiting",
    createdAt: now,
    updatedAt: now,
    state: "queued",
    source: { kind: "magnet", value: MAGNET },
    goal: "download",
    metadata: fakeMetadata(1, 500),
    selection: [0],
    selectedBytes: 500,
    completedFiles: null,
    stages: {
      ...initialStageMap(),
      metadata: "complete",
      selection: "complete",
      preflight: "complete",
      download: "waiting",
      packaging: "skipped",
      upload: "skipped",
      finalize: "skipped",
      cleanup: "skipped",
    },
    sessionEpoch: h.engine.sessionEpoch,
  };
  await h.repo.upsert(source);

  const preflight = await h.engine.preflightOrder([source.id]);
  assert.equal(preflight.selectedFiles, 1);
  assert.equal(preflight.blocked, false);

  const order = await h.engine.createOrder([source.id], null, {
    deleteTorrent: false,
    deleteFiles: false,
    deleteZip: true,
  });
  assert.equal((await h.engine.getJob(order.id)).waitingForDownloads, true);
  assert.equal(h.viking.uploadCalls.length, 0, "no upload before the source finishes");

  const finished = await h.engine.getJob(source.id);
  finished.state = "complete";
  finished.completedFiles = [
    { index: 0, absolutePath: "/data/jobs/dl-waiting/download/folder/file0.bin" },
  ];
  await h.repo.upsert(finished);

  // startupSweep also reconciles waiting orders.
  await h.engine.startupSweep();
  await waitFor(async () =>
    (await h.engine.getJob(order.id)).state === "complete" ? true : null,
  );

  const done = await h.engine.getJob(order.id);
  assert.equal(done.waitingForDownloads, false);
  assert.equal(h.viking.uploadCalls.length, 1);
  assert.equal(h.packaging.createZipCalls.length, 0, "single file uploads directly");
});
