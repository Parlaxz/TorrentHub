/**
 * Mapping from raw qBittorrent state strings to Viking Relay semantic classes.
 *
 * Verified against serialize_torrent.cpp (qBittorrent master, WebAPI >= 2.11.0
 * where pausedDL/pausedUP were renamed to stoppedDL/stoppedUP).
 */

import type { ProgressClassification } from './types';

const STATE_MAP: Record<string, ProgressClassification> = {
  downloading: 'downloading',
  forcedDL: 'downloading',
  metaDL: 'metadata',
  forcedMetaDL: 'metadata',
  stalledDL: 'waiting_for_peers',
  queuedDL: 'queued',
  stoppedDL: 'stopped',
  uploading: 'completed',
  stalledUP: 'completed',
  stoppedUP: 'completed',
  queuedUP: 'queued',
  forcedUP: 'completed',
  checkingDL: 'checking',
  checkingUP: 'checking',
  checkingResumeData: 'checking',
  moving: 'moving',
  error: 'error',
  missingFiles: 'error',
  unknown: 'unknown',
};

/** Classify a raw qBittorrent state. Unknown values classify as 'unknown'. */
export function classifyState(rawState: string): ProgressClassification {
  return STATE_MAP[rawState] ?? 'unknown';
}

/**
 * qBittorrent reports eta = 8640000 (100 days) when no meaningful ETA exists,
 * and some paths report negative values. Both map to null.
 */
export const QBIT_ETA_INFINITY_SENTINEL = 8_640_000;

export function normalizeEta(eta: number): number | null {
  if (!Number.isFinite(eta) || eta < 0 || eta >= QBIT_ETA_INFINITY_SENTINEL) return null;
  return eta;
}

/** Swarm counts use -1 for "unknown" in several qBittorrent versions. */
export function normalizeSwarmCount(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}
