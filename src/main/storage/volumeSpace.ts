import { statfs } from 'node:fs/promises';
import { StorageUnavailableError } from './errors.ts';
import type { VolumeSpaceInfo } from './types.ts';

export async function getVolumeSpace(path: string): Promise<VolumeSpaceInfo> {
  let stats: Awaited<ReturnType<typeof statfs>>;
  try {
    stats = await statfs(path);
  } catch (cause) {
    throw new StorageUnavailableError(path, { cause });
  }
  const blockSize = Number(stats.bsize);
  const totalBytes = blockSize * Number(stats.blocks);
  const freeBytes = blockSize * Number(stats.bavail);
  if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) || totalBytes <= 0) {
    throw new StorageUnavailableError(
      path,
      new Error(`statfs returned unusable values (total=${totalBytes}, free=${freeBytes})`),
    );
  }
  return { path, totalBytes, freeBytes };
}
