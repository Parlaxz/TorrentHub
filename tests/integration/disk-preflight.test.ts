/**
 * Integration: disk preflight (scenario 6).
 *
 * The StoragePolicyGateway applies A4's canonical policy: 2+ selected files
 * reserve estimated ZIP bytes + safety reserve; Start blocks with an exact
 * deficit when the peak does not fit. The engine surfaces the blocked
 * verdict and stays awaiting_selection.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { StoragePolicyGateway } from '../../src/main/integration/storage-gateway.ts';
import { computeSafetyReserve, estimateZipBytes } from '../../src/main/storage/index.ts';
import { JobEngine, resolveConfig } from '../../src/main/jobs/index.ts';
import type { JobEngineDeps } from '../../src/main/jobs/index.ts';
import {
  FakePackagingGateway,
  FakeTorrentGateway,
  FakeVikingGateway,
  FakeWorkspaceGateway,
    FakeDirectDownloadGateway,
  MemoryJobRepository,
  fakeMetadata,
} from '../jobs/fakes.ts';

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';

describe('integration: canonical disk preflight', () => {
  it('reserves estimated ZIP bytes for multifile selections (fresh statfs)', async () => {
    const gateway = new StoragePolicyGateway();
    const dir = await mkdtemp(path.join(tmpdir(), 'vr-preflight-'));
    const selectedBytes = 1024 * 1024 * 1024; // 1 GiB
    const fileCount = 3;

    const verdict = await gateway.preflight({
      path: dir,
      requiredBytes: selectedBytes * 2, // legacy coarse value, ignored
      safetyReserveBytes: 1, // legacy value, ignored
      selectedBytes,
      fileCount,
      zipRequired: true,
    });

    assert.equal(verdict.estimatedZipBytes, estimateZipBytes(selectedBytes, fileCount));
    assert.equal(verdict.safetyReserveBytes, computeSafetyReserve(selectedBytes));
    const expectedPeak =
      selectedBytes + estimateZipBytes(selectedBytes, fileCount) + computeSafetyReserve(selectedBytes);
    assert.equal(verdict.requiredPeakBytes, expectedPeak);
    if (verdict.freeBytes !== null) {
      assert.equal(verdict.deficitBytes, Math.max(0, expectedPeak - verdict.freeBytes));
      assert.equal(verdict.ok, verdict.freeBytes >= expectedPeak);
    }
  });

  it('blocks Start with an exact deficit when the peak cannot fit', async () => {
    const gateway = new StoragePolicyGateway();
    const dir = await mkdtemp(path.join(tmpdir(), 'vr-preflight-block-'));
    // Astronomical selection: guaranteed blocked on any real volume.
    const selectedBytes = Number.MAX_SAFE_INTEGER / 4;

    const verdict = await gateway.preflight({
      path: dir,
      requiredBytes: 0,
      safetyReserveBytes: 0,
      selectedBytes,
      fileCount: 2,
      zipRequired: true,
    });

    assert.equal(verdict.ok, false);
    assert.ok((verdict.deficitBytes ?? 0) > 0);
    assert.ok((verdict.requiredPeakBytes ?? 0) > selectedBytes);

    // Engine-level behavior: commit stays awaiting_selection + blocked view.
    const deps: JobEngineDeps = {
      torrent: new FakeTorrentGateway(fakeMetadata(2, selectedBytes / 2), [
        { downloadedBytes: 0, selectedComplete: false },
      ]),
      viking: new FakeVikingGateway(),
      packaging: new FakePackagingGateway(),
      storage: gateway,
      workspace: new FakeWorkspaceGateway(),
      direct: new FakeDirectDownloadGateway(),
      repository: new MemoryJobRepository(),
    };
    const engine = new JobEngine(
      deps,
      resolveConfig({
        jobsRoot: dir,
        historyFilePath: path.join(dir, 'history.json'),
        pollIntervalMs: 5,
      }),
    );
    const draft = await engine.createIntake(MAGNET);
    await assert.rejects(() => engine.commitSelection(draft.id, [0, 1]));
    const record = await engine.getJob(draft.id);
    assert.equal(record.state, 'awaiting_selection');
    assert.equal(record.preflight?.blocked, true);
    assert.equal(record.error?.kind, 'storage_preflight');
    assert.ok((record.preflight?.missingBytes ?? 0) > 0);
  });

  it('maps live headroom statuses onto storage views (blocked -> critical)', async () => {
    const gateway = new StoragePolicyGateway();
    const view = await gateway.liveHeadroom({
      path: 'C:/anywhere',
      freeBytes: 100,
      selectedTotalBytes: 10_000_000_000,
      downloadedSelectedBytes: 0,
      zipRequired: true,
      fileCount: 2,
    });
    assert.equal(view.warning, 'critical');
    assert.equal(view.projectedHeadroomBytes! < 0, true);
    assert.equal(view.zipReservationBytes, estimateZipBytes(10_000_000_000, 2));

    const okView = await gateway.liveHeadroom({
      path: 'C:/anywhere',
      freeBytes: 10_000_000_000_000,
      selectedTotalBytes: 1024,
      downloadedSelectedBytes: 0,
      zipRequired: false,
      fileCount: 1,
    });
    assert.equal(okView.warning, 'none');
    assert.equal(okView.zipReservationBytes, null);
  });
});


