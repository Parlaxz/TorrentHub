import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  InsufficientDiskSpaceError,
  evaluatePackagingStart,
  getVolumeSpace,
} from '../storage/index.ts';
import {
  InvalidPackagingRequestError,
  PackagingCancelledError,
  RenameFailedError,
  SelectedSourceMissingError,
  SourceNotRegularFileError,
  SourceSizeMismatchError,
} from './errors.ts';
import { resolveArchivePathCollisions, validateArchiveRelativePath } from './archivePath.ts';
import { writeStoreZip } from './zipWriter.ts';
import { isZipRequired } from './types.ts';
import type { PackagingOutcome, PackagingProgress, PackagingRequest } from './types.ts';

const INVALID_BASE_NAME_CHARS = /[\u0000-\u001f<>:"/\\|?*]/g;

export function sanitizeBaseName(rawBaseName: string): string {
  if (typeof rawBaseName !== 'string' || rawBaseName.trim().length === 0) {
    throw new InvalidPackagingRequestError('baseName must be a non-empty string');
  }
  const sanitized = rawBaseName
    .replace(INVALID_BASE_NAME_CHARS, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  if (sanitized.length === 0 || sanitized === '.' || sanitized === '..') {
    throw new InvalidPackagingRequestError(`baseName "${rawBaseName}" is not usable as a file name`);
  }
  return sanitized;
}

async function validateSources(request: PackagingRequest): Promise<void> {
  const validateSizes = request.validateSizes !== false;
  for (const file of request.files) {
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(file.absoluteSourcePath);
    } catch (cause) {
      throw new SelectedSourceMissingError(file.absoluteSourcePath, { cause });
    }
    if (!stats.isFile()) {
      const reason = stats.isSymbolicLink()
        ? 'symlink/reparse points are not followed'
        : 'not a regular file';
      throw new SourceNotRegularFileError(file.absoluteSourcePath, reason);
    }
    if (validateSizes && stats.size !== file.sizeBytes) {
      throw new SourceSizeMismatchError(file.absoluteSourcePath, file.sizeBytes, stats.size);
    }
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PackagingCancelledError();
}

async function removePartialBestEffort(partialPath: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(partialPath, { force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function packageSelectedFiles(
  request: PackagingRequest,
): Promise<PackagingOutcome> {
  if (!Array.isArray(request.files) || request.files.length === 0) {
    throw new InvalidPackagingRequestError('files must be a non-empty list of selected files');
  }
  assertNotAborted(request.signal);

  const archivePaths = resolveArchivePathCollisions(
    request.files.map((file) => validateArchiveRelativePath(file.archiveRelativePath)),
  );

  await validateSources(request);

  const totalSelectedBytes = request.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const zipRequired = isZipRequired(request.files.length, request.forceZip ?? false);

  if (!zipRequired) {
    return {
      kind: 'single-file',
      sourcePath: request.files[0].absoluteSourcePath,
      sizeBytes: request.files[0].sizeBytes,
    };
  }

  const baseName = sanitizeBaseName(request.baseName);
  const finalPath = join(request.outputDirectory, `${baseName}.zip`);
  const partialPath = join(request.outputDirectory, `${baseName}.partial.zip`);

  assertNotAborted(request.signal);

  const volume = request.storageProbe
    ? await request.storageProbe(request.outputDirectory)
    : await getVolumeSpace(request.outputDirectory);
  const startCheck = evaluatePackagingStart({
    currentFreeBytes: volume.freeBytes,
    selectedBytes: totalSelectedBytes,
    fileCount: request.files.length,
  });
  if (!startCheck.allowed) {
    throw new InsufficientDiskSpaceError({
      phase: 'packaging-start',
      freeBytes: startCheck.currentFreeBytes,
      requiredBytes: startCheck.requiredAdditionalBytes,
    });
  }

  await mkdir(request.outputDirectory, { recursive: true });

  assertNotAborted(request.signal);

  let archiveSizeBytes = 0;
  try {
    archiveSizeBytes = await writeStoreZip({
      outputPath: partialPath,
      entries: request.files.map((file, index) => ({
        sourcePath: file.absoluteSourcePath,
        archivePath: archivePaths[index],
      })),
      totalBytes: totalSelectedBytes,
      signal: request.signal,
      onProgress: (writerProgress) => {
        if (!request.onProgress) return;
        const progress: PackagingProgress = {
          processedBytes: writerProgress.processedBytes,
          totalBytes: writerProgress.totalBytes,
          progress: writerProgress.progress,
          throughputBytesPerSecond: writerProgress.throughputBytesPerSecond,
          filesCompleted: writerProgress.filesCompleted,
          filesTotal: request.files.length,
        };
        try {
          request.onProgress(progress);
        } catch {
        }
      },
    });
  } catch (error) {
    await removePartialBestEffort(partialPath);
    throw error;
  }

  assertNotAborted(request.signal);

  try {
    try {
      await rm(finalPath, { force: true });
    } catch {
    }
    await rename(partialPath, finalPath);
  } catch (cause) {
    await removePartialBestEffort(partialPath);
    throw new RenameFailedError(partialPath, finalPath, { cause });
  }

  return {
    kind: 'archive',
    archivePath: finalPath,
    archiveSizeBytes,
    fileCount: request.files.length,
  };
}
