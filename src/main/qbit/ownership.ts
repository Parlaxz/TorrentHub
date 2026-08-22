/**
 * Ownership markers and destructive-operation guards.
 *
 * NON-NEGOTIABLE SAFETY RULES implemented here:
 * - Every Viking Relay torrent carries tag AND category `vr_job_<jobId>`.
 * - Before ANY destructive operation we require: exact info-hash match,
 *   ownership tag/category presence, and save path containment.
 * - Any mismatch throws OwnershipMismatchError and the operation is aborted
 *   before the destructive call is issued.
 */

import { OwnershipMismatchError, ValidationError } from './errors';
import type { QbitTorrentInfo } from './types';

export const TAG_PREFIX = 'vr_job_';
export const INTAKE_TAG = 'vr_intake';

/** Tag/category name proving a job's ownership of a torrent. */
export function jobTag(jobId: string): string {
  return `${TAG_PREFIX}${jobId}`;
}

/**
 * Job ids become parts of tags (comma-separated API params) and hash filters
 * (pipe-separated). Both characters are forbidden, as is whitespace.
 */
export function validateJobId(jobId: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(jobId)) {
    throw new ValidationError(
      'Invalid Viking Relay job id (allowed: A-Z a-z 0-9 . _ -, max 128 chars)',
      { jobId },
    );
  }
}

/** qBittorrent reports tags either as an array or a comma-joined string. */
export function tagsOf(torrent: Pick<QbitTorrentInfo, 'tags'>): string[] {
  if (Array.isArray(torrent.tags)) return torrent.tags;
  if (typeof torrent.tags === 'string' && torrent.tags.length > 0) {
    return torrent.tags.split(',').map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

/** True when the torrent carries at least one Viking Relay ownership marker. */
export function hasVrOwnership(torrent: Pick<QbitTorrentInfo, 'tags' | 'category'>): boolean {
  const tags = tagsOf(torrent);
  if (tags.some((t) => t.startsWith(TAG_PREFIX) || t === INTAKE_TAG)) return true;
  if (torrent.category === INTAKE_TAG) return true;
  if (typeof torrent.category === 'string' && torrent.category.startsWith(TAG_PREFIX)) return true;
  return false;
}

/** Finds a vr_job_* marker belonging to a DIFFERENT job, if any. */
export function findForeignJobTag(torrent: Pick<QbitTorrentInfo, 'tags' | 'category'>, ownTag: string): string | null {
  const tags = tagsOf(torrent);
  const foreign = tags.find((t) => t.startsWith(TAG_PREFIX) && t !== ownTag);
  if (foreign) return foreign;
  if (
    typeof torrent.category === 'string' &&
    torrent.category.startsWith(TAG_PREFIX) &&
    torrent.category !== ownTag
  ) {
    return torrent.category;
  }
  return null;
}

/** Normalizes a filesystem path for comparison: "/" separators, no trailing slash, case-insensitive. */
export function normalizePath(p: string): string {
  const unified = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return unified.toLowerCase();
}

/** True when `child` equals or lives under `parent` (case/slash insensitive). */
export function pathWithin(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!p) return false;
  return c === p || c.startsWith(`${p}/`);
}

export interface OwnershipCheck {
  expectedInfoHash: string;
  expectedTag: string;
  expectedSavePathPrefix?: string;
}

/**
 * Verifies a torrent's identity + ownership + location. Throws
 * OwnershipMismatchError on the FIRST mismatch; never mutates anything.
 */
export function verifyOwnership(torrent: QbitTorrentInfo, check: OwnershipCheck): void {
  const expectedHash = check.expectedInfoHash.toLowerCase();
  if (torrent.hash.toLowerCase() !== expectedHash) {
    throw new OwnershipMismatchError('Refusing destructive operation: info hash mismatch', {
      expectedInfoHash: expectedHash,
      actualHash: torrent.hash,
      torrentName: torrent.name,
    });
  }

  const tags = tagsOf(torrent);
  const tagged = tags.includes(check.expectedTag);
  const categorized = torrent.category === check.expectedTag;
  if (!tagged && !categorized) {
    throw new OwnershipMismatchError(
      'Refusing destructive operation: torrent does not carry the expected Viking Relay ownership tag/category',
      {
        expectedTag: check.expectedTag,
        actualTags: tags,
        actualCategory: torrent.category,
        actualHash: torrent.hash,
      },
    );
  }

  if (check.expectedSavePathPrefix !== undefined) {
    if (!pathWithin(torrent.save_path, check.expectedSavePathPrefix)) {
      throw new OwnershipMismatchError(
        'Refusing destructive operation: save path is not within the expected per-job directory',
        {
          expectedSavePathPrefix: check.expectedSavePathPrefix,
          actualSavePath: torrent.save_path,
          actualHash: torrent.hash,
        },
      );
    }
  }
}
