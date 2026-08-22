/**
 * Progress/status mapping and SELECTED-files completion semantics.
 *
 * KEY INVARIANT: the packaging system treats the stored selected-index list as
 * canonical truth. Completion is computed from per-file progress of SELECTED
 * indexes only — never from which files happen to exist on disk, and never
 * from whole-torrent progress (which includes deselected files and may never
 * reach 1.0).
 *
 * LOW-SEED BEHAVIOR: zero speed / zero connected seeds are ordinary values,
 * never errors. `waiting_for_peers` is a semantic classification of stalledDL.
 */

import { IntakeNotFoundError } from './errors';
import type { QbitClient } from './client';
import type { IntakeRegistry as Registry } from './registry';
import { classifyState, normalizeEta, normalizeSwarmCount } from './statemap';
import type {
  JobProgress,
  JobRecord,
  QbitTorrentFile,
  QbitTorrentInfo,
  SelectedFilesCompletion,
} from './types';

/** Tolerance for per-file progress comparisons (qBittorrent reports 0..1). */
const COMPLETE_EPSILON = 1e-9;

export async function getSelectedFilesCompletion(
  client: QbitClient,
  registry: Registry,
  jobId: string,
): Promise<SelectedFilesCompletion> {
  const job = requireJob(registry, jobId);
  const files = await client.getTorrentFiles(job.infoHash);
  return computeCompletion(job, files);
}

export async function getJobProgress(
  client: QbitClient,
  registry: Registry,
  jobId: string,
): Promise<JobProgress> {
  const job = requireJob(registry, jobId);

  const infos = await client.getTorrents([job.infoHash]);
  const info = infos[0];
  if (!info) {
    throw new IntakeNotFoundError('Committed torrent no longer exists in qBittorrent', {
      jobId,
      infoHash: job.infoHash,
    });
  }

  let files: QbitTorrentFile[] = [];
  try {
    files = await client.getTorrentFiles(job.infoHash);
  } catch {
    // Metadata can transiently vanish during recheck; completion degrades to
    // zeros rather than failing the poll.
    files = [];
  }

  const completion = computeCompletion(job, files);

  return {
    jobId,
    infoHash: info.hash.toLowerCase(),
    name: info.name,
    stateRaw: info.state,
    classification: classifyState(info.state),
    progress: Number(info.progress) || 0,
    selectedProgress:
      completion.wantedBytes > 0
        ? Math.min(1, completion.downloadedWantedBytes / completion.wantedBytes)
        : 0,
    downloadedBytes: Number(info.downloaded) || 0,
    totalSize: Number(info.total_size ?? info.size) || 0,
    wantedBytes: completion.wantedBytes,
    downloadedWantedBytes: completion.downloadedWantedBytes,
    downloadSpeedBps: Number(info.dlspeed) || 0,
    uploadSpeedBps: Number(info.upspeed) || 0,
    etaSeconds: normalizeEta(Number(info.eta)),
    seedsConnected: Math.max(0, Number(info.num_seeds) || 0),
    seedsSwarm: normalizeSwarmCount(Number(info.num_complete)),
    peersConnected: Math.max(0, Number(info.num_leechs) || 0),
    peersSwarm: normalizeSwarmCount(Number(info.num_incomplete)),
    completion,
  };
}

/* ------------------------------------------------------------------ */

function requireJob(registry: Registry, jobId: string): JobRecord {
  const job = registry.getJob(jobId);
  if (!job) {
    throw new IntakeNotFoundError(`No committed Viking Relay job "${jobId}" known to the qbit adapter`, {
      jobId,
    });
  }
  return job;
}

export function computeCompletion(
  job: Pick<JobRecord, 'selectedIndexes'>,
  files: QbitTorrentFile[],
): SelectedFilesCompletion {
  const byIndex = new Map<number, QbitTorrentFile>();
  for (const f of files) byIndex.set(f.index, f);

  let wantedBytes = 0;
  let downloadedWantedBytes = 0;
  let completedCount = 0;
  const incompleteSelectedIndexes: number[] = [];

  for (const index of job.selectedIndexes) {
    const file = byIndex.get(index);
    // A missing entry means metadata is not (yet) available; treat as 0%.
    const size = file ? Number(file.size) || 0 : 0;
    const progress = file ? Number(file.progress) || 0 : 0;

    wantedBytes += size;
    downloadedWantedBytes += size * progress;

    if (progress >= 1 - COMPLETE_EPSILON) {
      completedCount += 1;
    } else {
      incompleteSelectedIndexes.push(index);
    }
  }

  return {
    complete:
      job.selectedIndexes.length > 0 && completedCount === job.selectedIndexes.length,
    selectedCount: job.selectedIndexes.length,
    completedCount,
    incompleteSelectedIndexes,
    wantedBytes,
    downloadedWantedBytes,
  };
}

/** Exposed for tests/UI heuristics: map raw torrent info without a job record. */
export function classifyTorrentInfo(info: QbitTorrentInfo): { stateRaw: string; classification: ReturnType<typeof classifyState> } {
  return { stateRaw: info.state, classification: classifyState(info.state) };
}
