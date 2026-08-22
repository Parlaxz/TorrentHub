/**
 * A4 → A5 storage gateway adapter — the CANONICAL disk-space policy.
 *
 * All authoritative figures come from A4's pure policy functions:
 *   estimatedZipBytes  = selectedBytes + fileCount * 512 + 64 KiB
 *   safetyReserve      = max(2 GiB, 5% of selectedBytes)
 *   pre-download peak  = selectedBytes + estimatedZipBytes + reserve
 *   live               = remainingDownload + zip + reserve vs fresh free
 *   packaging start    = fresh statfs; zip + reserve additional
 *
 * The engine's legacy coarse numbers (requiredBytes/safetyReserveBytes) are
 * only used as a fallback when canonical selection facts are absent.
 */
import {
  checkPreflight,
  computeLiveHeadroom,
  computeSafetyReserve,
  estimateZipBytes,
  evaluatePackagingStart,
  getVolumeSpace,
} from '../storage';
import type { StorageView } from '../jobs/types';
import type {
  LiveHeadroomRequest,
  PreflightRequest,
  PreflightVerdict,
  StorageGateway,
} from '../jobs/gateways';

export class StoragePolicyGateway implements StorageGateway {
  async statFreeBytes(volumePath: string): Promise<number | null> {
    try {
      const volume = await getVolumeSpace(volumePath);
      return volume.freeBytes;
    } catch {
      return null; // unknown volume: engine proceeds without blocking
    }
  }

  async preflight(request: PreflightRequest): Promise<PreflightVerdict> {
    if (
      request.selectedBytes !== undefined &&
      request.fileCount !== undefined &&
      request.zipRequired !== undefined
    ) {
      return this.canonicalPreflight(request);
    }
    return this.legacyPreflight(request);
  }

  async liveHeadroom(request: LiveHeadroomRequest): Promise<StorageView> {
    if (request.freeBytes === null) {
      return {
        freeBytes: null,
        remainingDownloadBytes: null,
        zipReservationBytes: null,
        safetyReserveBytes: null,
        projectedHeadroomBytes: null,
        warning: 'none',
      };
    }
    const result = computeLiveHeadroom({
      currentFreeBytes: request.freeBytes,
      selectedTotalBytes: request.selectedTotalBytes,
      downloadedSelectedBytes: request.downloadedSelectedBytes,
      zipRequired: request.zipRequired,
      fileCount: request.fileCount ?? 1,
    });
    return {
      freeBytes: request.freeBytes,
      remainingDownloadBytes: result.remainingDownloadBytes,
      zipReservationBytes: result.neededForZipBytes > 0 ? result.neededForZipBytes : null,
      safetyReserveBytes: result.safetyReserveBytes,
      projectedHeadroomBytes: result.projectedHeadroomBytes,
      warning:
        result.status === 'blocked' ? 'critical' : result.status === 'warning' ? 'low' : 'none',
    };
  }

  async evaluatePackagingStart(request: {
    path: string;
    selectedBytes: number;
    fileCount: number;
  }): Promise<{
    allowed: boolean;
    freeBytes: number | null;
    requiredAdditionalBytes: number | null;
    deficitBytes: number | null;
  }> {
    try {
      const volume = await getVolumeSpace(request.path);
      const evaluation = evaluatePackagingStart({
        currentFreeBytes: volume.freeBytes,
        selectedBytes: request.selectedBytes,
        fileCount: request.fileCount,
      });
      return {
        allowed: evaluation.allowed,
        freeBytes: volume.freeBytes,
        requiredAdditionalBytes: evaluation.requiredAdditionalBytes,
        deficitBytes: evaluation.deficitBytes,
      };
    } catch {
      // Unknown volume: do not block here; A4's in-packager fresh check is
      // still authoritative and will refuse to create artifacts.
      return { allowed: true, freeBytes: null, requiredAdditionalBytes: null, deficitBytes: null };
    }
  }

  // ------------------------------------------------------------- internals

  private async canonicalPreflight(request: PreflightRequest): Promise<PreflightVerdict> {
    const selectedBytes = request.selectedBytes!;
    const fileCount = request.fileCount!;
    const zipRequired = request.zipRequired!;
    try {
      const evaluation = await checkPreflight(request.path, {
        selectedBytes,
        zipRequired,
        fileCount,
      });
      const estimatedZip = zipRequired ? estimateZipBytes(selectedBytes, fileCount) : 0;
      const reserve = computeSafetyReserve(selectedBytes);
      const blocked = evaluation.status === 'blocked';
      return {
        ok: !blocked,
        freeBytes: evaluation.freeBytes,
        reason: blocked
          ? `insufficient disk space: peak ${evaluation.requiredPeakBytes} bytes required, ${evaluation.freeBytes} free`
          : undefined,
        estimatedZipBytes: estimatedZip,
        safetyReserveBytes: reserve,
        requiredPeakBytes: evaluation.requiredPeakBytes,
        deficitBytes: Math.max(0, evaluation.requiredPeakBytes - evaluation.freeBytes),
      };
    } catch {
      return {
        ok: true, // storage unavailable: engine proceeds, UI surfaces null headroom
        freeBytes: null,
        reason: 'storage unavailable for preflight',
        estimatedZipBytes: zipRequired ? estimateZipBytes(selectedBytes, fileCount) : 0,
        safetyReserveBytes: computeSafetyReserve(selectedBytes),
        requiredPeakBytes: null,
        deficitBytes: null,
      };
    }
  }

  private async legacyPreflight(request: PreflightRequest): Promise<PreflightVerdict> {
    const free = await this.statFreeBytes(request.path);
    if (free === null) {
      return { ok: true, freeBytes: null, reason: 'storage unavailable for preflight' };
    }
    const required = request.requiredBytes + request.safetyReserveBytes;
    return {
      ok: free >= required,
      freeBytes: free,
      reason: free < required ? `insufficient disk space: need ${required}, ${free} free` : undefined,
      requiredPeakBytes: required,
      deficitBytes: Math.max(0, required - free),
    };
  }
}
