/**
 * QbitTorrentService — the integration surface exported to the Viking Relay
 * job engine.
 *
 * Desired flow implemented end-to-end:
 *   magnet / HTTP(S) .torrent URL
 *     -> inspectTorrent()            (metadata only, nothing downloads)
 *     -> user picks file indexes
 *     -> commitTorrentSelection()    (unselected = priority 0 BEFORE start)
 *     -> getJobProgress()            (incl. selected-files completion)
 *     -> stopJobTorrent()            (after selected files complete)
 *     -> cleanupJobTorrent()         (ownership-proof-guarded deletion)
 */

import { QbitClient } from './client';
import { commitTorrentSelection, type CommitOptions } from './commit';
import { inspectTorrent, type InspectOptions } from './inspect';
import {
  cleanupJobTorrent,
  discardIntake,
  stopJobTorrent,
  type CleanupOptions,
} from './lifecycle';
import { getJobProgress, getSelectedFilesCompletion } from './progress';
import { IntakeRegistry } from './registry';
import type {
  CommitSelectionInput,
  CommitSelectionResult,
  IntakeToken,
  InspectedTorrent,
  JobProgress,
  OwnershipProof,
  QbitCapabilities,
  QbitClientConfig,
  QbitTorrentInfo,
  SelectedFilesCompletion,
} from './types';

export class QbitTorrentService {
  readonly client: QbitClient;
  private readonly registry = new IntakeRegistry();

  constructor(config: QbitClientConfig | QbitClient) {
    this.client = config instanceof QbitClient ? config : new QbitClient(config);
  }

  /** Health/version check + compatibility gate. */
  healthCheck(forceRefresh = false): Promise<QbitCapabilities> {
    return this.client.capabilities(forceRefresh);
  }

  /**
   * Fetch/parse metadata for a magnet URI or HTTP(S) .torrent URL WITHOUT
   * starting any download. Returns name, infohash(es), full file list, sizes,
   * and a stable intake token for commitTorrentSelection.
   */
  inspectTorrent(source: string, options?: InspectOptions): Promise<InspectedTorrent> {
    return inspectTorrent(this.client, this.registry, source, options);
  }

  /**
   * Commits the user's file selection for a job: selected files normal
   * priority, unselected files priority 0, ownership tag/category
   * vr_job_<jobId>, caller-supplied save path — then starts the download.
   * Returns the canonical torrent identity.
   */
  commitTorrentSelection(
    input: CommitSelectionInput,
    options?: CommitOptions,
  ): Promise<CommitSelectionResult> {
    return commitTorrentSelection(this.client, this.registry, input, options);
  }

  /** Full progress snapshot incl. semantic classification and completion. */
  getJobProgress(jobId: string): Promise<JobProgress> {
    return getJobProgress(this.client, this.registry, jobId);
  }

  /** Selected-files completion signal (canonical selection-list truth). */
  getSelectedFilesCompletion(jobId: string): Promise<SelectedFilesCompletion> {
    return getSelectedFilesCompletion(this.client, this.registry, jobId);
  }

  /** Stops torrent activity once selected files are complete. */
  stopJobTorrent(jobId: string): Promise<void> {
    return stopJobTorrent(this.client, this.registry, jobId);
  }

  /**
   * Guarded deletion. Requires proof: expectedInfoHash (mandatory),
   * expectedTag / expectedSavePathPrefix (default to recorded job values).
   */
  cleanupJobTorrent(
    jobId: string,
    proof: OwnershipProof,
    options?: CleanupOptions,
  ): Promise<void> {
    return cleanupJobTorrent(this.client, this.registry, jobId, proof, options);
  }

  /** Drops an intake that will never be committed (deletes parked fallback torrent). */
  discardIntake(token: IntakeToken): Promise<void> {
    return discardIntake(this.client, this.registry, token);
  }

  /**
   * Live WebAPI info for a committed job's torrent (content path, save path,
   * state). Returns null when the job is unknown to this process or the
   * torrent no longer exists. Used by the integration gateway to resolve
   * absolute paths of completed selected files.
   */
  async getJobTorrentInfo(jobId: string): Promise<QbitTorrentInfo | null> {
    const job = this.registry.getJob(jobId);
    if (!job) return null;
    const infos = await this.client.getTorrents([job.infoHash]);
    return infos[0] ?? null;
  }
}
