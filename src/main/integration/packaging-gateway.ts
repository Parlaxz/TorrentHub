/**
 * A4 → A5 packaging gateway adapter.
 *
 * Maps the engine's ZipRequest (explicit entries with torrent-relative
 * archive paths) onto A4's packageSelectedFiles. The ZIP preserves the
 * selected torrent's logical directory hierarchy — entries are NEVER reduced
 * to basenames and the packager never walks directories or calls
 * archive.directory() on a whole folder.
 *
 * The fresh pre-packaging disk check is A4's own implementation inside
 * packageSelectedFiles (evaluatePackagingStart with a fresh statfs), which
 * throws InsufficientDiskSpaceError before creating any artifact.
 */
import path from 'node:path';

import { packageSelectedFiles } from '../package';
import type {
  PackageResult,
  PackagingGateway,
  ZipRequest,
} from '../jobs/gateways';

export class PackagingGatewayAdapter implements PackagingGateway {
  async createZip(request: ZipRequest): Promise<PackageResult> {
    const outputDirectory = path.dirname(request.outputZipPath);
    const baseName = stripZipExtension(path.basename(request.outputZipPath));

    const outcome = await packageSelectedFiles({
      outputDirectory,
      baseName,
      files: request.entries.map((entry) => ({
        absoluteSourcePath: entry.absoluteSourcePath,
        archiveRelativePath: entry.archiveRelativePath,
        sizeBytes: entry.sizeBytes,
        torrentFileIndex: entry.torrentFileIndex,
      })),
      signal: request.abort,
      onProgress: (progress) => {
        request.onProgress?.({
          processedBytes: progress.processedBytes,
          totalBytes: progress.totalBytes,
          progress: progress.progress,
          throughputBytesPerSecond: Math.round(progress.throughputBytesPerSecond),
          filesCompleted: progress.filesCompleted,
          filesTotal: progress.filesTotal,
        });
      },
    });

    // The engine only invokes createZip for multi-file selections; a
    // single-file outcome is still handled correctly by passing it through.
    if (outcome.kind === 'single-file') {
      return { zipPath: outcome.sourcePath, sizeBytes: outcome.sizeBytes };
    }
    return { zipPath: outcome.archivePath, sizeBytes: outcome.archiveSizeBytes };
  }
}

function stripZipExtension(name: string): string {
  return name.replace(/\.zip$/i, '');
}
