/**
 * Lifecycle operations: stop and GUARDED cleanup.
 *
 * NON-NEGOTIABLE SAFETY:
 * - cleanup requires caller-supplied proof (expected info hash; optionally tag
 *   and save-path prefix). Every proof dimension is verified against the live
 *   torrent BEFORE the delete call is issued. Any mismatch aborts with
 *   OwnershipMismatchError — nothing is deleted or mutated.
 * - Deletion always targets ONE concrete lowercase hash. The string "all" is
 *   rejected outright.
 */

import { IntakeNotFoundError, OwnershipMismatchError } from './errors';
import type { QbitClient } from './client';
import type { IntakeRegistry as Registry } from './registry';
import { verifyOwnership } from './ownership';
import type { IntakeToken, OwnershipProof } from './types';

/**
 * Stops all torrent activity for a committed job (after selected files are
 * complete, before packaging/upload). Ownership-guarded.
 */
export async function stopJobTorrent(
  client: QbitClient,
  registry: Registry,
  jobId: string,
): Promise<void> {
  const job = requireJobRecord(registry, jobId);
  const info = await requireLiveTorrent(client, jobId, job.infoHash);

  verifyOwnership(info, {
    expectedInfoHash: job.infoHash,
    expectedTag: job.tag,
    expectedSavePathPrefix: job.savePath,
  });

  await client.stopTorrents([job.infoHash]);
}

export interface CleanupOptions {
  /** Delete downloaded content too. Default true. */
  deleteFiles?: boolean;
}

/**
 * Guarded deletion of a job's torrent. Requires proof supplied by the caller:
 * expectedInfoHash (mandatory), expectedTag / expectedSavePathPrefix (default
 * to the recorded job values when omitted).
 */
export async function cleanupJobTorrent(
  client: QbitClient,
  registry: Registry,
  jobId: string,
  proof: OwnershipProof,
  options: CleanupOptions = {},
): Promise<void> {
  if (!proof || typeof proof.expectedInfoHash !== 'string' || !proof.expectedInfoHash.trim()) {
    throw new OwnershipMismatchError(
      'cleanupJobTorrent requires explicit proof.expectedInfoHash',
      { jobId },
    );
  }

  const job = requireJobRecord(registry, jobId);
  const hash = job.infoHash;

  if (proof.expectedInfoHash.trim().toLowerCase() === 'all') {
    throw new OwnershipMismatchError('Refusing suspicious deletion target "all"', { jobId });
  }
  if (proof.expectedInfoHash.trim().toLowerCase() !== hash.toLowerCase()) {
    throw new OwnershipMismatchError(
      'Refusing deletion: proof hash does not match the job torrent',
      { jobId, expectedInfoHash: proof.expectedInfoHash, actualHash: hash },
    );
  }

  const info = await requireLiveTorrent(client, jobId, hash);

  verifyOwnership(info, {
    expectedInfoHash: hash,
    expectedTag: proof.expectedTag ?? job.tag,
    expectedSavePathPrefix: proof.expectedSavePathPrefix ?? job.savePath,
  });

  await client.deleteTorrents([hash], options.deleteFiles ?? true);
  registry.removeJob(jobId);
}

/**
 * Drops an intake that will never be committed. Deletes the parked fallback
 * intake torrent (metadata-only, nothing downloaded) when one exists.
 */
export async function discardIntake(
  client: QbitClient,
  registry: Registry,
  token: IntakeToken,
): Promise<void> {
  const record = registry.getIntake(token);
  if (!record) return;

  if (record.parkedTorrent) {
    try {
      await client.deleteTorrents([record.infoHash], false);
    } catch {
      // Already gone or unreachable — dropping the local reference is enough.
    }
  }
  registry.removeIntake(token);
}

/* ------------------------------------------------------------------ */

function requireJobRecord(registry: Registry, jobId: string) {
  const job = registry.getJob(jobId);
  if (!job) {
    throw new IntakeNotFoundError(`No committed Viking Relay job "${jobId}" known to the qbit adapter`, {
      jobId,
    });
  }
  return job;
}

async function requireLiveTorrent(client: QbitClient, jobId: string, hash: string) {
  const infos = await client.getTorrents([hash]);
  const info = infos[0];
  if (!info) {
    throw new IntakeNotFoundError('Torrent no longer exists in qBittorrent', {
      jobId,
      infoHash: hash,
    });
  }
  return info;
}
