/**
 * A2 → A5 qBittorrent gateway adapter.
 *
 * Satisfies the job engine's TorrentGateway using QbitTorrentService while
 * PRESERVING A2's ownership guarantees:
 *  - ownership is JOB-SPECIFIC (tag/category `vr_job_<jobId>`), never a
 *    generic relay-wide tag;
 *  - destructive cleanup requires exact proof: expected info hash + expected
 *    per-job tag + save-path containment. Handles reconstructed after an app
 *    restart carry the same proof fields; deletion is refused when any proof
 *    component is missing;
 *  - unmanaged duplicates are never commandeered (A2 commit refuses them).
 *
 * Completed selected-file paths are derived from the live torrent's
 * content_path plus metadata file paths (qBittorrent layout), then validated
 * to stay inside the per-job download root. The download folder is never
 * recursively enumerated.
 */
import path from 'node:path';

import { IntakeNotFoundError } from '../qbit/errors';
import { jobTag, verifyOwnership } from '../qbit/ownership';
import { QbitTorrentService } from '../qbit/service';
import type { IntakeToken, InspectedTorrent, QbitTorrentInfo } from '../qbit/types';
import type {
  AddTorrentOptions,
  TorrentGateway,
  TorrentHandle,
} from '../jobs/gateways';
import type { DownloadTelemetry, IntakeSource, TorrentMetadataInfo } from '../jobs/types';

/** Handle carrying the full ownership proof for guarded operations. */
export interface QbitJobHandle extends TorrentHandle {
  /** Canonical lowercase qBittorrent torrent id (infohash v1 / truncated v2). */
  torrentId: string;
  jobId: string;
  infoHash: string;
  /** Per-job download root the torrent was committed into. */
  savePathPrefix: string;
}

interface JobLayout {
  /** Metadata file entries in canonical index order. */
  files: Array<{ index: number; path: string; sizeBytes: number }>;
  selectedIndexes: number[];
}

export class QbitTorrentGateway implements TorrentGateway {
  private readonly tokensBySource = new Map<string, IntakeToken>();
  private readonly inspectedByToken = new Map<string, InspectedTorrent>();
  private readonly layoutByJob = new Map<string, JobLayout>();

  /**
   * A provider (not a fixed instance) so Electron main can apply qBittorrent
   * configuration changes without rebuilding the job engine. The provider is
   * only swapped while no transfer is active; registry-sensitive operations
   * keep their guarded fallbacks for the swap window.
   */
  constructor(private readonly resolveQbit: () => QbitTorrentService) {}

  private get qbit(): QbitTorrentService {
    return this.resolveQbit();
  }

  // ------------------------------------------------------------- metadata

  async fetchMetadata(source: IntakeSource): Promise<TorrentMetadataInfo> {
    const inspected = await this.qbit.inspectTorrent(source.value);
    this.tokensBySource.set(source.value, inspected.token);
    this.inspectedByToken.set(inspected.token, inspected);
    return toMetadataInfo(inspected);
  }

  // ---------------------------------------------------------------- commit

  async addTorrent(
    source: IntakeSource,
    options: AddTorrentOptions,
  ): Promise<TorrentHandle> {
    const token = await this.resolveIntakeToken(source);
    const result = await this.qbit.commitTorrentSelection({
      token,
      selectedIndexes: options.selectedIndexes,
      jobId: options.jobId,
      savePath: options.outputDir,
    });
    // Remember the torrent-relative layout for completed-path resolution.
    const inspected = await this.inspectedForToken(token);
    this.layoutByJob.set(options.jobId, {
      files: inspected.files.map((f) => ({
        index: f.index,
        path: f.path,
        sizeBytes: f.size,
      })),
      selectedIndexes: [...options.selectedIndexes].sort((a, b) => a - b),
    });
    const handle: QbitJobHandle = {
      torrentId: result.infoHash.toLowerCase(),
      jobId: result.jobId,
      infoHash: result.infoHash.toLowerCase(),
      savePathPrefix: result.savePath,
    };
    return handle;
  }

  // -------------------------------------------------------------- progress

  async getProgress(handle: TorrentHandle): Promise<DownloadTelemetry> {
    const h = asQbitHandle(handle);
    const progress = await this.qbit.getJobProgress(h.jobId);
    const telemetry: DownloadTelemetry = {
      progressPct: progress.selectedProgress * 100,
      downloadedBytes: Math.round(progress.downloadedWantedBytes),
      totalSelectedBytes: progress.wantedBytes,
      speedBps: progress.downloadSpeedBps,
      etaSeconds: progress.etaSeconds,
      seeds: progress.seedsConnected,
      peers: progress.peersConnected,
      selectedComplete: progress.completion.complete,
      selectedFiles: null,
    };

    if (progress.completion.complete) {
      telemetry.selectedFiles = await this.resolveCompletedSelectedPaths(h);
    }
    return telemetry;
  }

  // ------------------------------------------------------------- lifecycle

  async stop(handle: TorrentHandle): Promise<void> {
    const h = asQbitHandle(handle);
    try {
      await this.qbit.stopJobTorrent(h.jobId);
    } catch (error) {
      if (error instanceof IntakeNotFoundError) {
        // Registry lost (e.g. post-restart): stop by canonical hash directly.
        await this.qbit.client.stopTorrents([h.infoHash]);
        return;
      }
      throw error;
    }
  }

  /**
   * Guarded delete. Refuses without complete proof; verifies identity +
   * vr_job_<jobId> marker + save-path containment before deleting.
   */
  async deleteOwned(handle: TorrentHandle, deleteData: boolean): Promise<void> {
    const h = asQbitHandle(handle);
    if (!h.jobId || !h.savePathPrefix) {
      throw new Error('deleteOwned refused: incomplete ownership proof');
    }
    const proof = {
      expectedInfoHash: h.infoHash,
      expectedTag: jobTag(h.jobId),
      expectedSavePathPrefix: h.savePathPrefix,
    };
    try {
      await this.qbit.cleanupJobTorrent(h.jobId, proof, { deleteFiles: deleteData });
    } catch (error) {
      if (error instanceof IntakeNotFoundError) {
        await this.deleteWithLocalGuard(h, proof, deleteData);
        return;
      }
      throw error;
    }
  }

  // ------------------------------------------------------------- internals

  /**
   * Post-restart fallback: the in-memory registry no longer knows the job, so
   * the guard is replicated locally with the SAME proof dimensions before the
   * destructive call is issued.
   */
  private async deleteWithLocalGuard(
    h: QbitJobHandle,
    proof: { expectedInfoHash: string; expectedTag: string; expectedSavePathPrefix: string },
    deleteData: boolean,
  ): Promise<void> {
    const infos = await this.qbit.client.getTorrents([h.infoHash]);
    const info = infos[0];
    if (!info) return; // already gone — nothing to delete
    verifyOwnership(info, proof);
    await this.qbit.client.deleteTorrents([h.infoHash], deleteData);
  }

  private async resolveIntakeToken(source: IntakeSource): Promise<IntakeToken> {
    const cached = this.tokensBySource.get(source.value);
    if (cached) return cached;
    // Registry miss (e.g. restart between intake and commit): re-inspect.
    // Metadata-only fetch adds nothing to the session on qBittorrent >= 5.2.
    const inspected = await this.qbit.inspectTorrent(source.value);
    this.tokensBySource.set(source.value, inspected.token);
    this.inspectedByToken.set(inspected.token, inspected);
    return inspected.token;
  }

  private async inspectedForToken(token: IntakeToken): Promise<InspectedTorrent> {
    const cached = this.inspectedByToken.get(token);
    if (!cached) throw new Error('intake metadata vanished before commit');
    return cached;
  }

  /**
   * Absolute paths for all completed SELECTED files.
   *
   * Layout rule (qBittorrent Original content layout): every reported file
   * path lives under the parent of the torrent's content_path. Each resolved
   * path is validated against the per-job download root before being returned.
   */
  private async resolveCompletedSelectedPaths(
    h: QbitJobHandle,
  ): Promise<Array<{ index: number; absolutePath: string }>> {
    const layout = this.layoutByJob.get(h.jobId);
    if (!layout) {
      throw new Error(`no cached layout for job ${h.jobId}`);
    }
    const info = await this.safeLiveInfo(h);
    // With Original layout every reported file path lives under the parent of
    // content_path. Fallback when the live info is unavailable: the per-job
    // download root itself.
    const baseDir =
      info?.content_path && info.content_path.trim().length > 0
        ? path.dirname(info.content_path)
        : h.savePathPrefix;

    const byIndex = new Map(layout.files.map((f) => [f.index, f]));
    const out: Array<{ index: number; absolutePath: string }> = [];
    for (const index of layout.selectedIndexes) {
      const entry = byIndex.get(index);
      if (!entry) throw new Error(`metadata missing for selected file index ${index}`);
      const absolutePath = path.join(baseDir, entry.path);
      assertWithinJobRoot(absolutePath, h.savePathPrefix);
      out.push({ index, absolutePath });
    }
    return out;
  }

  private async safeLiveInfo(h: QbitJobHandle): Promise<QbitTorrentInfo | null> {
    try {
      return await this.qbit.getJobTorrentInfo(h.jobId);
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */

function toMetadataInfo(inspected: InspectedTorrent): TorrentMetadataInfo {
  return {
    name: inspected.name,
    infoHashV1: inspected.infoHashV1 ?? inspected.infoHash,
    infoHashV2: inspected.infoHashV2 ?? undefined,
    files: inspected.files.map((f) => ({
      index: f.index,
      path: f.path,
      sizeBytes: f.size,
    })),
    totalSizeBytes: inspected.totalSize,
  };
}

function asQbitHandle(handle: TorrentHandle): QbitJobHandle {
  const h = handle as Partial<QbitJobHandle>;
  if (!h || typeof h.torrentId !== 'string' || h.torrentId.length === 0) {
    throw new Error('invalid torrent handle');
  }
  if (typeof h.jobId !== 'string' || h.jobId.length === 0) {
    throw new Error('torrent handle lacks job ownership identity');
  }
  return handle as QbitJobHandle;
}

function assertWithinJobRoot(absolutePath: string, jobRoot: string): void {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const child = norm(absolutePath);
  const parent = norm(jobRoot);
  if (!child.startsWith(`${parent}/`)) {
    throw new Error(
      `resolved source path escaped the per-job download root: ${absolutePath}`,
    );
  }
}
