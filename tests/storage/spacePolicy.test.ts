import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GIB,
  SAFETY_RESERVE_RATIO,
  ZIP_FIXED_OVERHEAD_BYTES,
  ZIP_METADATA_PER_FILE_BYTES,
  classifyStatus,
  computeLiveHeadroom,
  computeSafetyReserve,
  computeSpaceRequirement,
  estimateZipBytes,
  evaluatePackagingStart,
  evaluatePreflight,
} from '../../src/main/storage/index.ts';

describe('estimateZipBytes', () => {
  it('adds bounded metadata overhead on top of selected bytes', () => {
    const selected = 10 * GIB;
    const est = estimateZipBytes(selected, 3);
    const overhead = est - selected;
    assert.equal(overhead, 3 * ZIP_METADATA_PER_FILE_BYTES + ZIP_FIXED_OVERHEAD_BYTES);
  });

  it('never uses a ridiculous multiplier', () => {
    const selected = 100 * GIB;
    const est = estimateZipBytes(selected, 50);
    assert.ok(est < selected * 1.001);
    assert.ok(est > selected);
  });

  it('rejects invalid inputs', () => {
    assert.throws(() => estimateZipBytes(-1, 1), TypeError);
    assert.throws(() => estimateZipBytes(Number.NaN, 1), TypeError);
    assert.throws(() => estimateZipBytes(100, 0), TypeError);
  });
});

describe('computeSafetyReserve', () => {
  it('uses the 2 GiB floor for small selections', () => {
    assert.equal(computeSafetyReserve(0), 2 * GIB);
    assert.equal(computeSafetyReserve(1024), 2 * GIB);
  });

  it('uses 5% for large selections', () => {
    assert.equal(computeSafetyReserve(100 * GIB), 5 * GIB);
    assert.equal(computeSafetyReserve(40 * GIB + 1), Math.ceil((40 * GIB + 1) * 0.05));
  });
});

describe('computeSpaceRequirement', () => {
  it('single file without zip: peak = selected + reserve', () => {
    const req = computeSpaceRequirement({ selectedBytes: 4 * GIB, zipRequired: false });
    assert.equal(req.requiredPeakBytes, 4 * GIB + 2 * GIB);
    assert.equal(req.estimatedZipBytes, 0);
  });

  it('multi file with zip: peak = selected + estimatedZip + reserve', () => {
    const req = computeSpaceRequirement({
      selectedBytes: 90 * GIB,
      zipRequired: true,
      fileCount: 2,
    });
    assert.equal(
      req.requiredPeakBytes,
      90 * GIB + estimateZipBytes(90 * GIB, 2) + computeSafetyReserve(90 * GIB),
    );
  });

  it('accepts explicit overrides for estimate and reserve', () => {
    const req = computeSpaceRequirement({
      selectedBytes: 1000,
      zipRequired: true,
      estimatedZipBytes: 1200,
      safetyReserveBytes: 300,
    });
    assert.equal(req.requiredPeakBytes, 1000 + 1200 + 300);
  });
});

describe('classifyStatus', () => {
  it('blocked when headroom is negative', () => {
    assert.equal(classifyStatus(-1, 100 * GIB), 'blocked');
  });

  it('warning when headroom is non-zero but below threshold', () => {
    assert.equal(classifyStatus(0, 100 * GIB), 'warning');
    assert.equal(classifyStatus(GIB - 1, 100 * GIB), 'warning');
  });

  it('ok when headroom reaches the warning threshold', () => {
    assert.equal(classifyStatus(GIB, GIB), 'ok');
    assert.equal(classifyStatus(Math.ceil(100 * GIB * 0.1), 100 * GIB), 'ok');
    assert.equal(classifyStatus(50 * GIB, 100 * GIB), 'ok');
  });

  it('warning threshold scales with requirement size', () => {
    assert.equal(classifyStatus(1.4 * GIB, 15 * GIB), 'warning');
    assert.equal(classifyStatus(2 * GIB, 15 * GIB), 'ok');
  });
});

describe('evaluatePreflight', () => {
  it('computes headroom from free minus required peak', () => {
    const req = computeSpaceRequirement({ selectedBytes: 10 * GIB, zipRequired: false });
    const evaluation = evaluatePreflight(50 * GIB, req);
    assert.equal(evaluation.projectedHeadroomBytes, 50 * GIB - (12 * GIB));
    assert.equal(evaluation.status, 'ok');
  });

  it('reports blocked when free space cannot cover the peak', () => {
    const req = computeSpaceRequirement({ selectedBytes: 100 * GIB, zipRequired: true });
    const evaluation = evaluatePreflight(50 * GIB, req);
    assert.equal(evaluation.status, 'blocked');
    assert.ok(evaluation.projectedHeadroomBytes < 0);
  });
});

describe('computeLiveHeadroom', () => {
  it('matches the UI example shape: free minus download+zip+reserve', () => {
    const result = computeLiveHeadroom({
      currentFreeBytes: 221 * GIB,
      selectedTotalBytes: 92 * GIB,
      downloadedSelectedBytes: 66 * GIB,
      zipRequired: true,
      fileCount: 12,
    });
    assert.equal(result.neededToFinishDownloadBytes, 26 * GIB);
    assert.equal(result.neededForZipBytes, estimateZipBytes(92 * GIB, 12));
    assert.equal(result.safetyReserveBytes, Math.ceil(92 * GIB * SAFETY_RESERVE_RATIO));
    assert.equal(
      result.requiredFutureBytes,
      26 * GIB + estimateZipBytes(92 * GIB, 12) + Math.ceil(92 * GIB * SAFETY_RESERVE_RATIO),
    );
    assert.equal(
      result.projectedHeadroomBytes,
      221 * GIB - result.requiredFutureBytes,
    );
    assert.equal(result.status, 'ok');
  });

  it('no zip means only remaining download plus reserve are needed', () => {
    const result = computeLiveHeadroom({
      currentFreeBytes: 10 * GIB,
      selectedTotalBytes: 8 * GIB,
      downloadedSelectedBytes: 3 * GIB,
      zipRequired: false,
    });
    assert.equal(result.remainingDownloadBytes, 5 * GIB);
    assert.equal(result.neededForZipBytes, 0);
    assert.equal(result.requiredFutureBytes, 5 * GIB + 2 * GIB);
    assert.equal(result.projectedHeadroomBytes, 3 * GIB);
    assert.equal(result.status, 'ok');
  });

  it('blocks when free cannot cover future needs', () => {
    const result = computeLiveHeadroom({
      currentFreeBytes: 1 * GIB,
      selectedTotalBytes: 8 * GIB,
      downloadedSelectedBytes: 0,
      zipRequired: true,
    });
    assert.equal(result.status, 'blocked');
    assert.ok(result.projectedHeadroomBytes < 0);
  });

  it('clamps remaining download at zero when everything is downloaded', () => {
    const result = computeLiveHeadroom({
      currentFreeBytes: 100 * GIB,
      selectedTotalBytes: 8 * GIB,
      downloadedSelectedBytes: 8 * GIB,
      zipRequired: false,
    });
    assert.equal(result.remainingDownloadBytes, 0);
    assert.equal(result.requiredFutureBytes, 2 * GIB);
  });

  it('rejects downloaded exceeding total', () => {
    assert.throws(
      () =>
        computeLiveHeadroom({
          currentFreeBytes: 10,
          selectedTotalBytes: 5,
          downloadedSelectedBytes: 6,
          zipRequired: false,
        }),
      RangeError,
    );
  });
});

describe('evaluatePackagingStart', () => {
  it('allows when free covers zip estimate plus reserve', () => {
    const selected = 20 * GIB;
    const requiredAdditional =
      estimateZipBytes(selected, 3) + computeSafetyReserve(selected);
    const evaluation = evaluatePackagingStart({
      currentFreeBytes: requiredAdditional + 7 * GIB,
      selectedBytes: selected,
      fileCount: 3,
    });
    assert.equal(evaluation.allowed, true);
    assert.equal(evaluation.deficitBytes, 0);
    assert.equal(evaluation.projectedHeadroomAfterPackagingBytes, 7 * GIB);
  });

  it('blocks with exact deficit when free is insufficient', () => {
    const selected = 20 * GIB;
    const requiredAdditional =
      estimateZipBytes(selected, 3) + computeSafetyReserve(selected);
    const free = requiredAdditional - 1234;
    const evaluation = evaluatePackagingStart({
      currentFreeBytes: free,
      selectedBytes: selected,
      fileCount: 3,
    });
    assert.equal(evaluation.allowed, false);
    assert.equal(evaluation.deficitBytes, 1234);
    assert.equal(evaluation.status, 'blocked');
  });

  it('reserve switches from floor to ratio for large selections', () => {
    const selected = 200 * GIB;
    const evaluation = evaluatePackagingStart({
      currentFreeBytes: estimateZipBytes(selected, 2) + 10 * GIB - 1,
      selectedBytes: selected,
      fileCount: 2,
    });
    assert.equal(evaluation.allowed, false);
    assert.ok(evaluation.deficitBytes <= 1);
  });
});
