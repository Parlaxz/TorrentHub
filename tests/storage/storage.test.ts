import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  InsufficientDiskSpaceError,
  StorageUnavailableError,
  assertPreflightAllowsStart,
  checkPreflight,
  computeSpaceRequirement,
  getVolumeSpace,
  sampleLiveHeadroom,
} from '../../src/main/storage/index.ts';

describe('getVolumeSpace', () => {
  it('returns positive totals with free <= total', async () => {
    const info = await getVolumeSpace(tmpdir());
    assert.equal(info.path, tmpdir());
    assert.ok(info.totalBytes > 0);
    assert.ok(info.freeBytes > 0);
    assert.ok(info.freeBytes <= info.totalBytes);
  });

  it('throws StorageUnavailableError for a missing path', async () => {
    const bogus = join(tmpdir(), 'viking-relay-does-not-exist-xyz');
    await assert.rejects(() => getVolumeSpace(bogus), StorageUnavailableError);
  });
});

describe('checkPreflight', () => {
  it('reports ok for a tiny selection on a real volume', async () => {
    const evaluation = await checkPreflight(tmpdir(), {
      selectedBytes: 10 * 1024 * 1024,
      zipRequired: true,
      fileCount: 3,
    });
    assert.equal(evaluation.status, 'ok');
    assert.ok(evaluation.projectedHeadroomBytes > 0);
  });

  it('blocks for an astronomically large selection without mocking the disk', async () => {
    const huge = Math.floor(Number.MAX_SAFE_INTEGER / 4);
    const evaluation = await checkPreflight(tmpdir(), {
      selectedBytes: huge,
      zipRequired: true,
      fileCount: 2,
    });
    assert.equal(evaluation.status, 'blocked');
    assert.ok(evaluation.projectedHeadroomBytes < 0);
  });

  it('requirement matches the pure calculator', async () => {
    const requirement = computeSpaceRequirement({
      selectedBytes: 1024,
      zipRequired: false,
    });
    const evaluation = await checkPreflight(tmpdir(), {
      selectedBytes: 1024,
      zipRequired: false,
    });
    assert.equal(evaluation.requiredPeakBytes, requirement.requiredPeakBytes);
  });
});

describe('assertPreflightAllowsStart', () => {
  it('resolves when space is sufficient', async () => {
    const evaluation = await assertPreflightAllowsStart(tmpdir(), {
      selectedBytes: 1024,
      zipRequired: false,
    });
    assert.notEqual(evaluation.status, 'blocked');
  });

  it('rejects with InsufficientDiskSpaceError and deficit details when blocked', async () => {
    const huge = Math.floor(Number.MAX_SAFE_INTEGER / 4);
    await assert.rejects(
      () =>
        assertPreflightAllowsStart(tmpdir(), {
          selectedBytes: huge,
          zipRequired: true,
          fileCount: 1,
        }),
      (error: unknown) => {
        assert.ok(error instanceof InsufficientDiskSpaceError);
        assert.equal(error.phase, 'preflight');
        assert.ok(error.deficitBytes > 0);
        assert.ok(error.requiredBytes > error.freeBytes);
        return true;
      },
    );
  });
});

describe('sampleLiveHeadroom', () => {
  it('combines fresh statfs with the live calculator', async () => {
    const result = await sampleLiveHeadroom(tmpdir(), {
      selectedTotalBytes: 1024,
      downloadedSelectedBytes: 512,
      zipRequired: true,
      fileCount: 2,
    });
    assert.ok(result.projectedHeadroomBytes > 0);
    assert.equal(result.neededToFinishDownloadBytes, 512);
    assert.ok(result.requiredFutureBytes >= 512 + 2 * 1024 ** 3);
    assert.ok(result.neededForZipBytes >= 1024);
  });
});
