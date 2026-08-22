/**
 * commitTorrentSelection — turn an inspected intake into a running, selective
 * download owned by a specific Viking Relay job.
 *
 * RACE-FREE ORDERING (hard product requirement):
 *   1. torrent is added STOPPED (or adopted from the parked intake)
 *   2. unselected files -> priority 0 FIRST (failure-safe: if we crash after
 *      this step, only wanted files could ever download)
 *   3. selected files -> priority 1
 *   4. priorities are READ BACK and verified
 *   5. only then is the torrent started
 *
 * No payload download can begin before file selection is committed.
 */

import {
  DuplicateUnmanagedTorrentError,
  IntakeNotFoundError,
  MetadataUnavailableError,
  QbitApiError,
  QbitAuthError,
  QbitTorrentErroredError,
  SelectionInvalidError,
  SelectionNotAppliedError,
} from './errors';
import type { QbitClient } from './client';
import type { IntakeRegistry as Registry } from './registry';
import {
  INTAKE_TAG,
  findForeignJobTag,
  jobTag,
  tagsOf,
  validateJobId,
  verifyOwnership,
} from './ownership';
import { DEFAULT_METADATA_TIMEOUT_MS, sleep } from './inspect';
import { classifyState } from './statemap';
import type {
  CommitSelectionInput,
  CommitSelectionResult,
  JobRecord,
  QbitTorrentFile,
  QbitTorrentInfo,
} from './types';

export interface CommitOptions {
  /** Max wait for metadata when a fresh add is required. Default 120000ms. */
  metadataTimeoutMs?: number;
  pollIntervalMs?: number;
}

export async function commitTorrentSelection(
  client: QbitClient,
  registry: Registry,
  input: CommitSelectionInput,
  options: CommitOptions = {},
): Promise<CommitSelectionResult> {
  // ---- validation -------------------------------------------------------
  validateJobId(input.jobId);
  if (!input.savePath || typeof input.savePath !== 'string') {
    throw new SelectionInvalidError('savePath must be supplied by the caller', {
      jobId: input.jobId,
    });
  }
  const selected = normalizeIndexes(input.selectedIndexes);
  if (selected.length === 0) {
    throw new SelectionInvalidError('selectedIndexes must contain at least one file index', {
      jobId: input.jobId,
    });
  }

  const record = registry.getIntake(input.token);
  if (!record) {
    throw new IntakeNotFoundError(
      'Unknown intake token — inspectTorrent must run first in this session',
      { token: input.token },
    );
  }

  const allIndexes = record.files.map((f) => f.index);
  const unknown = selected.filter((i) => !allIndexes.includes(i));
  if (unknown.length > 0) {
    throw new SelectionInvalidError('selectedIndexes contains indexes outside the inspected file list', {
      jobId: input.jobId,
      unknownIndexes: unknown,
      validRange: [0, allIndexes.length - 1],
    });
  }

  const tag = jobTag(input.jobId);
  const hash = record.infoHash;

  // ---- ensure the torrent exists and is ours ----------------------------
  let info: QbitTorrentInfo | undefined = (await client.getTorrents([hash]))[0];

  if (info) {
    try {
      assertCommitOwnership(info, tag);
    } catch (err) {
      // A previous FAILED attempt leaves its vr_job_<oldJob> tag behind.
      // When that leftover is inactive (not actively transferring), remove
      // it and re-add fresh instead of refusing the retry.
      const otherTag =
        err instanceof DuplicateUnmanagedTorrentError
          ? (err.details?.otherJobTag as string | undefined)
          : undefined;
      if (otherTag && isInactiveTorrentState(info.state)) {
        await client.deleteTorrents([hash], false);
        info = undefined;
      } else {
        throw err;
      }
    }
  }

  if (!info) {
    await addFreshStopped(
      client,
      record.source,
      record.sourceKind,
      hash,
      input.savePath,
      tag,
      options,
    );
    // Re-check; "Fails." may have been a concurrent duplicate add.
    info = (await client.getTorrents([hash]))[0];
    if (!info) {
      throw new QbitApiError('Torrent was added but could not be found afterwards', {
        status: 0,
        statusText: 'missing after add',
        endpoint: '/torrents/info',
      });
    }
    assertCommitOwnership(info, tag);
  }

  // ---- ownership markers -------------------------------------------------
  await client.createCategory(tag, input.savePath);
  await client.createTags([tag]);
  await client.addTags([hash], [tag]);
  await client.setCategory([hash], tag);
  try {
    await client.removeTags([hash], [INTAKE_TAG]);
  } catch {
    // Best-effort; intake tag absence is not fatal.
  }

  // ---- selection -> priorities (while still stopped) ---------------------
  const selectedSet = new Set(selected);
  const unselected = allIndexes.filter((i) => !selectedSet.has(i));

  // Failure-safe order: deselect first.
  await client.setFilePriority(hash, unselected, 0);
  await client.setFilePriority(hash, selected, 1);

  // Read back and verify BEFORE starting.
  const filesAfter = await client.getTorrentFiles(hash);
  verifyPriorities(filesAfter, selected, unselected);

  // ---- start -------------------------------------------------------------
  await client.startTorrents([hash]);

  // Post-start sanity: identity + ownership + location must hold on the live
  // torrent. Any drift => stop immediately and refuse.
  const live = (await client.getTorrents([hash]))[0];
  if (!live) {
    throw new QbitApiError('Torrent disappeared right after start', {
      status: 0,
      statusText: 'missing',
      endpoint: '/torrents/info',
    });
  }
  if (classifyState(live.state) === 'error') {
    try {
      await client.stopTorrents([hash]);
    } catch {
      /* best-effort containment */
    }
    throw new QbitTorrentErroredError(
      `qBittorrent reports the torrent in an error state ("${live.state}")`,
      { infoHash: hash, rawState: live.state },
    );
  }
  try {
    verifyOwnership(live, {
      expectedInfoHash: hash,
      expectedTag: tag,
      expectedSavePathPrefix: input.savePath,
    });
  } catch (err) {
    try {
      await client.stopTorrents([hash]);
    } catch {
      /* best-effort containment */
    }
    throw err;
  }

  const jobRecord: JobRecord = {
    jobId: input.jobId,
    infoHash: hash,
    selectedIndexes: selected,
    savePath: input.savePath,
    tag,
    category: tag,
    committedAt: Date.now(),
  };
  registry.putJob(jobRecord);

  return {
    jobId: input.jobId,
    infoHash: hash,
    infoHashV1: record.infoHashV1,
    infoHashV2: record.infoHashV2,
    name: live.name || record.name,
    savePath: input.savePath,
    category: tag,
    tag,
    selectedIndexes: selected,
  };
}

/* ------------------------------------------------------------------ */

function normalizeIndexes(indexes: number[]): number[] {
  if (!Array.isArray(indexes)) return [];
  const seen = new Set<number>();
  for (const value of indexes) {
    if (!Number.isInteger(value) || value < 0) return [];
    seen.add(value);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Torrent states safe to auto-remove on a retry: nothing is actively
 * transferring, so deleting the leftover cannot break a live download.
 */
const REMOVABLE_STATES = new Set([
  'stopped',
  'stoppedUP',
  'stoppedDL',
  'pausedUP',
  'pausedDL',
  'errored',
  'missingFiles',
]);

function isInactiveTorrentState(state: string | undefined): boolean {
  return typeof state === 'string' && REMOVABLE_STATES.has(state);
}

/**
 * An existing identical torrent may only be adopted when it carries THIS job's
 * marker or the intake marker. Anything else is refused — never commandeered.
 */
interface TorrentLike {
  tags: string | string[];
  category: string;
  hash: string;
  name: string;
}

function assertCommitOwnership(info: TorrentLike, ownTag: string): void {
  const foreign = findForeignJobTag(info, ownTag);
  const tags = tagsOf(info);
  const ownsIt =
    tags.includes(ownTag) ||
    info.category === ownTag ||
    tags.includes(INTAKE_TAG) ||
    info.category === INTAKE_TAG;

  if (!ownsIt) {
    throw new DuplicateUnmanagedTorrentError(
      'An identical torrent already exists in qBittorrent but is NOT managed by Viking Relay. ' +
        'Remove it manually (or tag it) before retrying.',
      { infoHash: info.hash.toLowerCase(), existingTags: tags, existingCategory: info.category },
    );
  }
  if (foreign) {
    throw new DuplicateUnmanagedTorrentError(
      'An identical torrent exists but belongs to another Viking Relay job. Refusing to commandeer it.',
      {
        infoHash: info.hash.toLowerCase(),
        otherJobTag: foreign,
        existingTags: tags,
        existingCategory: info.category,
      },
    );
  }
}

async function addFreshStopped(
  client: QbitClient,
  source: string,
  sourceKind: 'magnet' | 'url',
  hash: string,
  savePath: string,
  tag: string,
  options: CommitOptions,
): Promise<void> {
  try {
    await client.addTorrent({
      urls: [source],
      stopped: true,
      stopCondition: sourceKind === 'magnet' ? 'MetadataReceived' : undefined,
      savePath,
      category: tag,
      tags: [tag],
      autoTMM: false,
    });
  } catch (err) {
    // "Fails." can mean a concurrent duplicate appeared between our existence
    // check and the add. Return; the caller re-checks existence and will
    // surface DuplicateUnmanagedTorrentError when appropriate.
    if (err instanceof QbitApiError && err.details?.statusText === 'Fails.') {
      return;
    }
    throw err;
  }

  // Wait until metadata is present so filePrio can act.
  const timeoutMs = options.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
  const intervalMs = options.pollIntervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    let files: QbitTorrentFile[];
    try {
      files = await client.getTorrentFiles(hash);
    } catch (err) {
      // A freshly added magnet has no file list yet; several qBittorrent
      // versions answer /torrents/files with 404 (or similar) until metadata
      // arrives. Tolerate transient lookups while waiting — auth failures
      // will not heal, so rethrow those immediately.
      if (err instanceof QbitAuthError) throw err;
      lastError = err;
      if (Date.now() >= deadline) break;
      await sleep(intervalMs);
      continue;
    }
    lastError = null;
    if (files.length > 0) return;
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  if (lastError !== null) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new MetadataUnavailableError(
      `Could not read the torrent's file list after adding it (${detail})`,
      { source, infoHash: hash },
    );
  }
  throw new MetadataUnavailableError(
    `Timed out after ${timeoutMs}ms waiting for metadata after add`,
    { source, infoHash: hash },
  );
}

function verifyPriorities(
  files: QbitTorrentFile[],
  selected: number[],
  unselected: number[],
): void {
  const prioByIndex = new Map<number, number>();
  for (const f of files) prioByIndex.set(f.index, f.priority);

  const wrongDeselected = unselected.filter((i) => prioByIndex.get(i) !== 0);
  const wrongSelected = selected.filter((i) => (prioByIndex.get(i) ?? -1) <= 0);

  if (wrongDeselected.length > 0 || wrongSelected.length > 0) {
    throw new SelectionNotAppliedError(
      'qBittorrent did not apply the requested file priorities; refusing to start the torrent',
      {
        wrongDeselected: wrongDeselected.map((i) => ({ index: i, priority: prioByIndex.get(i) })),
        wrongSelected: wrongSelected.map((i) => ({ index: i, priority: prioByIndex.get(i) })),
      },
    );
  }
}
