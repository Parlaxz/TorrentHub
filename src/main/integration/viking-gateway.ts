/**
 * A3 → A5 Viking gateway adapter.
 *
 * Wraps VikingClient.uploadFile (session → parts → complete) and maps its
 * byte-accurate progress onto the engine's UploadProgressView. Cancellation
 * is cooperative via the AbortSignal only. The configured user hash stays
 * inside the main process; nothing here touches renderers.
 *
 * Verification uses A3's check-file endpoint. Per the engine's finalize
 * semantics, verification failure never destroys a successfully returned URL.
 */
import { stat } from 'node:fs/promises';

import { VikingClient } from '../viking';
import type {
  UploadProgressView,
  VikingGateway,
  VikingUploadResult,
} from '../jobs/gateways';

export class VikingGatewayAdapter implements VikingGateway {
  /**
   * A provider so Electron main can apply Viking credential changes without
   * rebuilding the job engine (only swapped while no transfer is active).
   */
  constructor(private readonly resolveClient: () => VikingClient) {}

  private get client(): VikingClient {
    return this.resolveClient();
  }

  async upload(request: {
    filePath: string;
    fileName: string;
    sizeBytes: number | null;
    abort: AbortSignal;
    onProgress?: (progress: UploadProgressView) => void;
  }): Promise<VikingUploadResult> {
    const size =
      request.sizeBytes ?? (await stat(request.filePath)).size;

    const result = await this.client.uploadFile(
      { path: request.filePath, size, name: request.fileName },
      {
        signal: request.abort,
        onProgress: (progress) => {
          request.onProgress?.({
            uploadedBytes: progress.uploadedBytes,
            totalBytes: progress.totalBytes,
            progress: progress.progress,
            speedBps: Math.round(progress.bytesPerSecond),
            etaSeconds: progress.etaSeconds,
            completedParts: progress.completedParts,
            totalParts: progress.totalParts,
          });
        },
      },
    );

    return {
      url: result.url,
      // Viking's file hash doubles as the verification identity for check-file.
      sha256: result.hash ?? null,
      sizeBytes: result.size ?? size,
    };
  }

  /**
   * check-file verification. Returns false when the hash is unknown or the
   * file no longer exists; throws only on transport-level errors (the engine
   * treats any throw as "verification unavailable", not as job failure).
   */
  async verify(result: VikingUploadResult): Promise<boolean> {
    if (!result.sha256) return false;
    const check = await this.client.verifyUploadedFile(result.sha256);
    return check.exists;
  }
}
