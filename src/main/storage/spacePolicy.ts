import type {
  LiveHeadroomInput,
  LiveHeadroomResult,
  PackagingStartEvaluation,
  PackagingStartInput,
  PreflightEvaluation,
  SpaceRequirement,
  SpaceRequirementInput,
} from './types.ts';

export const GIB = 1024 ** 3;

export const SAFETY_RESERVE_FLOOR_BYTES = 2 * GIB;
export const SAFETY_RESERVE_RATIO = 0.05;

export const ZIP_METADATA_PER_FILE_BYTES = 512;
export const ZIP_FIXED_OVERHEAD_BYTES = 64 * 1024;

export const WARNING_HEADROOM_FLOOR_BYTES = GIB;
export const WARNING_HEADROOM_RATIO = 0.1;

function assertByteQuantity(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number, got ${String(value)}`);
  }
  return value;
}

export function estimateZipBytes(selectedBytes: number, fileCount: number): number {
  assertByteQuantity(selectedBytes, 'selectedBytes');
  if (!Number.isInteger(fileCount) || fileCount < 1) {
    throw new TypeError(`fileCount must be a positive integer, got ${String(fileCount)}`);
  }
  return (
    Math.ceil(selectedBytes) +
    fileCount * ZIP_METADATA_PER_FILE_BYTES +
    ZIP_FIXED_OVERHEAD_BYTES
  );
}

export function computeSafetyReserve(selectedBytes: number): number {
  assertByteQuantity(selectedBytes, 'selectedBytes');
  return Math.max(SAFETY_RESERVE_FLOOR_BYTES, Math.ceil(selectedBytes * SAFETY_RESERVE_RATIO));
}

export function computeSpaceRequirement(input: SpaceRequirementInput): SpaceRequirement {
  const selectedBytes = assertByteQuantity(input.selectedBytes, 'selectedBytes');
  const fileCount = input.fileCount ?? 1;
  if (!Number.isInteger(fileCount) || fileCount < 1) {
    throw new TypeError(`fileCount must be a positive integer, got ${String(fileCount)}`);
  }
  const estimatedZipBytes =
    input.estimatedZipBytes ?? (input.zipRequired ? estimateZipBytes(selectedBytes, fileCount) : 0);
  const safetyReserveBytes = input.safetyReserveBytes ?? computeSafetyReserve(selectedBytes);
  const requiredPeakBytes =
    selectedBytes + (input.zipRequired ? estimatedZipBytes : 0) + safetyReserveBytes;
  return {
    selectedBytes,
    zipRequired: input.zipRequired,
    fileCount,
    estimatedZipBytes,
    safetyReserveBytes,
    requiredPeakBytes,
  };
}

export function warningThresholdBytes(requiredBytes: number): number {
  return Math.max(WARNING_HEADROOM_FLOOR_BYTES, Math.ceil(requiredBytes * WARNING_HEADROOM_RATIO));
}

export function classifyStatus(
  projectedHeadroomBytes: number,
  requiredBytes: number,
): 'ok' | 'warning' | 'blocked' {
  if (projectedHeadroomBytes < 0) return 'blocked';
  if (projectedHeadroomBytes < warningThresholdBytes(requiredBytes)) return 'warning';
  return 'ok';
}

export function evaluatePreflight(
  currentFreeBytes: number,
  requirement: SpaceRequirement,
): PreflightEvaluation {
  assertByteQuantity(currentFreeBytes, 'currentFreeBytes');
  const projectedHeadroomBytes = currentFreeBytes - requirement.requiredPeakBytes;
  return {
    status: classifyStatus(projectedHeadroomBytes, requirement.requiredPeakBytes),
    freeBytes: currentFreeBytes,
    requiredPeakBytes: requirement.requiredPeakBytes,
    projectedHeadroomBytes,
    warningThresholdBytes: warningThresholdBytes(requirement.requiredPeakBytes),
  };
}

export function computeLiveHeadroom(input: LiveHeadroomInput): LiveHeadroomResult {
  const currentFreeBytes = assertByteQuantity(input.currentFreeBytes, 'currentFreeBytes');
  const selectedTotalBytes = assertByteQuantity(input.selectedTotalBytes, 'selectedTotalBytes');
  const downloadedSelectedBytes = assertByteQuantity(
    input.downloadedSelectedBytes,
    'downloadedSelectedBytes',
  );
  if (downloadedSelectedBytes > selectedTotalBytes) {
    throw new RangeError('downloadedSelectedBytes cannot exceed selectedTotalBytes');
  }
  const fileCount = input.fileCount ?? 1;
  if (!Number.isInteger(fileCount) || fileCount < 1) {
    throw new TypeError(`fileCount must be a positive integer, got ${String(fileCount)}`);
  }

  const remainingDownloadBytes = Math.max(0, selectedTotalBytes - downloadedSelectedBytes);
  const neededForZipBytes = input.zipRequired
    ? estimateZipBytes(selectedTotalBytes, fileCount)
    : 0;
  const safetyReserveBytes = computeSafetyReserve(selectedTotalBytes);
  const requiredFutureBytes = remainingDownloadBytes + neededForZipBytes + safetyReserveBytes;
  const projectedHeadroomBytes = currentFreeBytes - requiredFutureBytes;

  return {
    status: classifyStatus(projectedHeadroomBytes, requiredFutureBytes),
    remainingDownloadBytes,
    neededToFinishDownloadBytes: remainingDownloadBytes,
    neededForZipBytes,
    safetyReserveBytes,
    requiredFutureBytes,
    projectedHeadroomBytes,
    warningThresholdBytes: warningThresholdBytes(requiredFutureBytes),
  };
}

export function evaluatePackagingStart(input: PackagingStartInput): PackagingStartEvaluation {
  const currentFreeBytes = assertByteQuantity(input.currentFreeBytes, 'currentFreeBytes');
  const selectedBytes = assertByteQuantity(input.selectedBytes, 'selectedBytes');
  if (!Number.isInteger(input.fileCount) || input.fileCount < 1) {
    throw new TypeError(`fileCount must be a positive integer, got ${String(input.fileCount)}`);
  }
  const requiredAdditionalBytes =
    estimateZipBytes(selectedBytes, input.fileCount) + computeSafetyReserve(selectedBytes);
  const projectedHeadroomAfterPackagingBytes = currentFreeBytes - requiredAdditionalBytes;
  return {
    allowed: projectedHeadroomAfterPackagingBytes >= 0,
    status: classifyStatus(projectedHeadroomAfterPackagingBytes, requiredAdditionalBytes),
    requiredAdditionalBytes,
    currentFreeBytes,
    projectedHeadroomAfterPackagingBytes,
    deficitBytes: Math.max(0, requiredAdditionalBytes - currentFreeBytes),
  };
}
