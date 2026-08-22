export type StorageStatus = 'ok' | 'warning' | 'blocked';

export interface VolumeSpaceInfo {
  path: string;
  totalBytes: number;
  freeBytes: number;
}

export interface SpaceRequirementInput {
  selectedBytes: number;
  zipRequired: boolean;
  fileCount?: number;
  estimatedZipBytes?: number;
  safetyReserveBytes?: number;
}

export interface SpaceRequirement {
  selectedBytes: number;
  zipRequired: boolean;
  fileCount: number;
  estimatedZipBytes: number;
  safetyReserveBytes: number;
  requiredPeakBytes: number;
}

export interface PreflightEvaluation {
  status: StorageStatus;
  freeBytes: number;
  requiredPeakBytes: number;
  projectedHeadroomBytes: number;
  warningThresholdBytes: number;
}

export interface LiveHeadroomInput {
  currentFreeBytes: number;
  selectedTotalBytes: number;
  downloadedSelectedBytes: number;
  zipRequired: boolean;
  fileCount?: number;
}

export interface LiveHeadroomResult {
  status: StorageStatus;
  remainingDownloadBytes: number;
  neededToFinishDownloadBytes: number;
  neededForZipBytes: number;
  safetyReserveBytes: number;
  requiredFutureBytes: number;
  projectedHeadroomBytes: number;
  warningThresholdBytes: number;
}

export interface PackagingStartInput {
  currentFreeBytes: number;
  selectedBytes: number;
  fileCount: number;
}

export interface PackagingStartEvaluation {
  allowed: boolean;
  status: StorageStatus;
  requiredAdditionalBytes: number;
  currentFreeBytes: number;
  projectedHeadroomAfterPackagingBytes: number;
  deficitBytes: number;
}
