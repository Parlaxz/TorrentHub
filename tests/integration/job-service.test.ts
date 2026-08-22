/**
 * Integration seam A5 → A6: EngineJobService over the real JobEngine.
 *
 * Covers: REST mapping (intake/start/get/cancel/retry), public snapshot
 * stripping of server-local filesystem paths, blocked-Start preflight
 * surfacing, structured error mapping (404/409), and zero-seed waiting
 * propagation without failure.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { JobEngine, resolveConfig } from '../../src/main/jobs/index.ts';
import type { JobEngineDeps } from '../../src/main/jobs/index.ts';
import {
  FakePackagingGateway,
  FakeStorageGateway,
  FakeTorrentGateway,
  FakeVikingGateway,
  FakeWorkspaceGateway,
    FakeDirectDownloadGateway,
  MemoryJobRepository,
  fakeMetadata,
} from '../jobs/fakes.ts';
import { EngineJobService } from '../../src/main/integration/job-service.ts';

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';

interface World {
  service: EngineJobService;
  engine: JobEngine;
  torrent: FakeTorrentGateway;
  storage: FakeStorageGateway;
  repository: MemoryJobRepository;
}

async function setup(
  telemetryScript: Array<Record<string, unknown>>,
  config: Record<string, unknown> = {},
  sizePerFile = 1000,
): Promise<World> {
  const torrent = new FakeTorrentGateway(fakeMetadata(2, sizePerFile), telemetryScript as never);
  const storage = new FakeStorageGateway([Number.MAX_SAFE_INTEGER]);
  const deps: JobEngineDeps = {
    torrent,
    viking: new FakeVikingGateway([{ url: 'https://viking.example/f/abc', sha256: 'h' }]),
    packaging: new FakePackagingGateway([{ sizeBytes: 2100 }]),
    storage,
    workspace: new FakeWorkspaceGateway(),
      direct: new FakeDirectDownloadGateway(),
    repository: new MemoryJobRepository(),
  };
  const root = await mkdtemp(path.join(tmpdir(), 'vr-jobservice-'));
  const engine = new JobEngine(
    deps,
    resolveConfig({
      jobsRoot: root,
      historyFilePath: path.join(root, 'history.json'),
      pollIntervalMs: 5,
      safetyReserveBytes: 0, // FakeStorageGateway reports a fixed 1 GiB free
      ...config,
    }),
  );
  return {
    service: new EngineJobService(engine),
    engine,
    torrent,
    storage,
    repository: deps.repository as MemoryJobRepository,
  };
}

describe('integration: A5 -> A6 job service', () => {
  it('maps intake -> start -> get with a stripped public snapshot', async () => {
    const world = await setup([{ downloadedBytes: 2000, selectedComplete: true }]);
    const draft = await world.service.createIntake({
      source: { kind: 'magnet', value: MAGNET },
    });
    assert.equal(draft.state, 'awaiting_selection');
    assert.equal(draft.metadata?.files.length, 2);

    // Committed jobs are no longer intake drafts.
    const job = await world.service.createJob({
      intakeId: draft.id,
      selection: [1, 0],
      idempotencyKey: 'start-x',
    });
    assert.equal(job.id, draft.id);
    assert.deepEqual(job.selection, [0, 1]);
    assert.equal(job.zipRequired, true);
    assert.equal(job.state === 'queued' || job.state === 'downloading', true);

    // Public snapshot must NOT expose server-local filesystem paths.
    for (const forbidden of [
      'jobDir',
      'downloadDir',
      'packageDir',
      'zipPath',
      'directSourcePath',
      'completedFiles',
      'torrentId',
      'sessionEpoch',
      'idempotencyKey',
      'startIdempotencyKey',
    ]) {
      assert.equal(forbidden in job, false, `${forbidden} must be stripped`);
    }
    assert.ok(job.storagePreflight);
    assert.equal(job.storagePreflight!.selectedFiles, 2);
    assert.equal(job.storagePreflight!.blocked, false);
    assert.ok(job.storagePreflight!.tempZipBytes !== null);

    await world.engine.whenIdle();
    const done = await world.service.getJob(job.id);
    assert.equal(done?.state, 'complete');
    assert.equal(done?.result?.url, 'https://viking.example/f/abc');

    // Draft lookup no longer resolves for committed jobs.
    assert.equal(await world.service.getIntake(draft.id), null);
  });

  it('surfaces an authoritative blocked preflight when Start cannot fit', async () => {
    // 2 × 600 MB selected => 1.2 GB peak; the fake gateway reports 1 GB free.
    const world = await setup([{ downloadedBytes: 0, selectedComplete: false }], {}, 600_000_000);

    const draft = await world.service.createIntake({
      source: { kind: 'magnet', value: MAGNET },
    });
    const response = await world.service.createJob({ intakeId: draft.id, selection: [0, 1] });

    assert.equal(response.state, 'awaiting_selection');
    assert.ok(response.preflight);
    assert.equal(response.preflight!.blocked, true);
    assert.equal(response.preflight!.enough, false);
    assert.ok((response.preflight!.missingBytes ?? 0) > 0);
    assert.equal(response.error?.kind, 'storage_preflight');
  });

  it('maps missing jobs to 404 and invalid transitions to 409', async () => {
    const world = await setup([{ downloadedBytes: 2000, selectedComplete: true }]);

    assert.equal(await world.service.getJob('does-not-exist'), null);

    const draft = await world.service.createIntake({
      source: { kind: 'magnet', value: MAGNET },
    });
    await assert.rejects(
      () => world.service.retryPackaging(draft.id),
      (error: { statusCode?: number; code?: string }) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, 'job_conflict');
        return true;
      },
    );

    await assert.rejects(
      () => world.service.cancelJob('does-not-exist'),
      (error: { statusCode?: number; code?: string }) => {
        assert.equal(error.statusCode, 404);
        return true;
      },
    );
  });

  it('cancels a draft and lists only terminal jobs in history', async () => {
    const world = await setup([{ downloadedBytes: 2000, selectedComplete: true }]);
    const draft = await world.service.createIntake({
      source: { kind: 'magnet', value: MAGNET },
    });
    const cancelled = await world.service.cancelJob(draft.id);
    assert.equal(cancelled.state, 'cancelled');

    const history = await world.service.listHistory(50);
    assert.equal(history.some((j) => j.id === draft.id), true);
    // listJobs still exposes everything; history is terminal-only.
    const all = await world.service.listJobs();
    assert.equal(all.some((j) => j.state === 'cancelled'), true);
  });

  it('propagates zero-seed waiting state without failing the job', async () => {
    const world = await setup(
      [{ downloadedBytes: 0, speedBps: 0, seeds: 0, peers: 0, selectedComplete: false }],
      { zeroSpeedMs: 10 },
    );
    const draft = await world.service.createIntake({
      source: { kind: 'magnet', value: MAGNET },
    });
    await world.service.createJob({ intakeId: draft.id, selection: [0] });

    // Let several polls run at sustained zero speed.
    await new Promise((r) => setTimeout(r, 120));

    const mid = await world.engine.getJob(draft.id);
    assert.equal(mid.state, 'downloading', 'zero seeds must NOT fail the job');
    assert.equal(mid.telemetry?.seeds, 0);
    assert.equal(mid.telemetry?.speedBps, 0);
    assert.equal(mid.hint, 'waiting_for_peers');

    // Public view carries the same waiting telemetry.
    const pub = await world.service.getJob(draft.id);
    assert.equal(pub?.telemetry?.seeds, 0);
    assert.equal(pub?.hint, 'waiting_for_peers');

    // Stop the poll loop so the test process can exit.
    await world.service.cancelJob(draft.id);
    await world.engine.whenIdle().catch(() => undefined);
  });
});


