/**
 * inspectTorrent — metadata-only torrent inspection.
 *
 * PRIMARY PATH (qBittorrent >= 5.2 / WebAPI >= 2.11.9):
 *   POST /torrents/fetchMetadata retrieves name + file list WITHOUT adding the
 *   torrent to the session. Nothing is parked, nothing can download. Polls
 *   until HTTP 200 carries `info`, or times out.
 *
 * FALLBACK PATH (WebAPI 2.11.0–2.11.8, opt-in via minWebApiVersion):
 *   Adds the source with stopped=true + stopCondition=MetadataReceived into a
 *   quarantined intake category/tag. qBittorrent fetches metadata and stops
 *   itself before any payload piece is requested (officially supported
 *   pattern). The parked torrent stays under tag `vr_intake` until commit
 *   adopts it or discardIntake deletes it.
 *
 * In BOTH paths no payload download can begin during inspection: magnets have
 * no payload before metadata exists, and .torrent URLs added `stopped` never
 * start.
 */

import { MalformedMetadataError, MetadataUnavailableError } from './errors';
import { QbitClient } from './client';
import type { IntakeRegistry as Registry } from './registry';
import { INTAKE_TAG } from './ownership';
import { parseTorrentSource } from './magnet';
import { mintIntakeToken } from './tokens';
import type {
  InspectedFile,
  InspectedTorrent,
  IntakeRecord,
  QbitFetchMetadataResponse,
  QbitTorrentFile,
  QbitTorrentInfo,
} from './types';

export interface InspectOptions {
  /** Max wall time to wait for metadata. Default 120000ms. */
  metadataTimeoutMs?: number;
  /** Poll interval while waiting. Default 1000ms. */
  pollIntervalMs?: number;
  /**
   * Fallback tier only: REQUIRED quarantine save path for parked intake
   * torrents. Supplied by the host app (e.g. <userData>/vr-intake).
   */
  intakeSavePath?: string;
}

export const DEFAULT_METADATA_TIMEOUT_MS = 120_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

export async function inspectTorrent(
  client: QbitClient,
  registry: Registry,
  source: string,
  options: InspectOptions = {},
): Promise<InspectedTorrent> {
  const parsed = parseTorrentSource(source);
  const caps = await client.capabilities();

  let record: IntakeRecord;

  if (caps.tier === 'fetchMetadata') {
    record = await inspectViaFetchMetadata(client, parsed.raw, parsed.kind, options);
  } else {
    record = await inspectViaParkedAdd(client, parsed, options);
  }

  registry.putIntake(record);

  return {
    token: record.token,
    name: record.name,
    infoHash: record.infoHash,
    infoHashV1: record.infoHashV1,
    infoHashV2: record.infoHashV2,
    files: record.files,
    totalSize: record.totalSize,
    sourceKind: record.sourceKind,
    isPrivate: record.isPrivate,
  };
}

/* ------------------------------------------------------------------ */
/* Primary: dedicated fetchMetadata endpoint                           */
/* ------------------------------------------------------------------ */

async function inspectViaFetchMetadata(
  client: QbitClient,
  source: string,
  kind: 'magnet' | 'url',
  options: InspectOptions,
): Promise<IntakeRecord> {
  const timeoutMs = options.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const result = await client.fetchMetadataOnce(source);
    if (result.state === 'ready') {
      return recordFromFetchMetadata(result.meta, source, kind);
    }
    if (Date.now() >= deadline) {
      throw new MetadataUnavailableError(
        `Timed out after ${timeoutMs}ms waiting for torrent metadata`,
        { source },
      );
    }
    await sleep(intervalMs);
  }
}

function recordFromFetchMetadata(
  meta: QbitFetchMetadataResponse,
  source: string,
  kind: 'magnet' | 'url',
): IntakeRecord {
  const rawFiles = meta.info?.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new MalformedMetadataError('Metadata response contains no files', { source });
  }
  const name = meta.info.name;
  if (!name) {
    throw new MalformedMetadataError('Metadata response has no torrent name', { source });
  }

  const files: InspectedFile[] = rawFiles.map((f, index) => ({
    index,
    path: f.path,
    size: Number(f.length),
  }));

  const infoHash = meta.hash || meta.infohash_v1 || meta.infohash_v2;
  if (!infoHash) {
    throw new MalformedMetadataError('Metadata response has no usable hash/infohash', { source });
  }

  return {
    token: mintIntakeToken(infoHash),
    source,
    sourceKind: kind,
    infoHash: infoHash.toLowerCase(),
    infoHashV1: meta.infohash_v1 ? meta.infohash_v1.toLowerCase() : null,
    infoHashV2: meta.infohash_v2 ? meta.infohash_v2.toLowerCase() : null,
    name,
    files,
    totalSize: Number(meta.info.length) || files.reduce((sum, f) => sum + f.size, 0),
    isPrivate: typeof meta.info.private === 'boolean' ? meta.info.private : null,
    parkedTorrent: false,
    inspectedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* Fallback: parked add with stopCondition=MetadataReceived            */
/* ------------------------------------------------------------------ */

async function inspectViaParkedAdd(
  client: QbitClient,
  parsed: ReturnType<typeof parseTorrentSource>,
  options: InspectOptions,
): Promise<IntakeRecord> {
  const timeoutMs = options.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  // Kept dependency-free on purpose: the adapter never imports node builtins.
  if (!options.intakeSavePath) {
    throw new Error(
      'inspectTorrent fallback tier requires options.intakeSavePath (quarantine directory)',
    );
  }
  const intakeSavePath = options.intakeSavePath;

  await client.addTorrent({
    urls: [parsed.raw],
    stopped: true,
    stopCondition: 'MetadataReceived',
    category: INTAKE_TAG,
    tags: [INTAKE_TAG],
    autoTMM: false,
    savePath: intakeSavePath,
  });

  // Discover the torrent's hash. Prefer a locally-extracted v1 btih; otherwise
  // match against recently-added vr_intake-tagged torrents.
  const startedAt = Math.floor(Date.now() / 1000) - 5;
  let torrent: QbitTorrentInfo | undefined;

  while (Date.now() < deadline) {
    const candidates = await client.getTorrents();
    torrent = candidates.find((t) => matchesIntake(t, parsed));
    if (torrent && torrent.added_on >= startedAt - 30) break;
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }

  if (!torrent) {
    throw new MetadataUnavailableError(
      `Timed out after ${timeoutMs}ms waiting for the intake torrent to appear in qBittorrent`,
      { source: parsed.raw },
    );
  }

  // Wait for metadata (files list becomes non-empty).
  let files: QbitTorrentFile[] = [];
  while (Date.now() < deadline) {
    files = await client.getTorrentFiles(torrent.hash);
    if (files.length > 0) break;
    await sleep(intervalMs);
  }

  if (files.length === 0) {
    throw new MetadataUnavailableError(
      `Timed out after ${timeoutMs}ms waiting for torrent metadata`,
      { source: parsed.raw, infoHash: torrent.hash },
    );
  }

  const inspectedFiles: InspectedFile[] = files.map((f) => ({
    index: f.index,
    path: f.name,
    size: Number(f.size),
  }));

  const name = torrent.name || parsed.displayName || '';
  if (!name) {
    throw new MalformedMetadataError('Intake torrent has no name', { source: parsed.raw });
  }

  return {
    token: mintIntakeToken(torrent.hash),
    source: parsed.raw,
    sourceKind: parsed.kind,
    infoHash: torrent.hash.toLowerCase(),
    infoHashV1: parsed.infoHashV1 ?? null,
    infoHashV2: parsed.infoHashV2 ?? null,
    name,
    files: inspectedFiles,
    totalSize:
      Number(torrent.total_size) || inspectedFiles.reduce((sum, f) => sum + f.size, 0),
    isPrivate: null,
    parkedTorrent: true,
    inspectedAt: Date.now(),
  };
}

function matchesIntake(
  torrent: QbitTorrentInfo,
  parsed: ReturnType<typeof parseTorrentSource>,
): boolean {
  const tags = Array.isArray(torrent.tags)
    ? torrent.tags
    : String(torrent.tags ?? '').split(',').map((t) => t.trim());
  if (!tags.includes(INTAKE_TAG)) return false;

  if (parsed.infoHashV1 && torrent.hash.toLowerCase() === parsed.infoHashV1) return true;

  const magnetUri = torrent.magnet_uri ?? '';
  if (parsed.infoHashV1 && magnetUri.toLowerCase().includes(parsed.infoHashV1)) return true;
  if (parsed.displayName && torrent.name === parsed.displayName) return true;

  // URL sources: the intake tag plus recency is the best available signal.
  return parsed.kind === 'url';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
