/**
 * Public contracts for the Viking Relay qBittorrent adapter.
 *
 * These are INTERNAL to src/main/qbit until shared contracts appear in
 * src/shared. They are intentionally dependency-free so they can be re-exported
 * or mirrored later without churn.
 */

/** How the torrent source was supplied by the user/UI. */
export type TorrentSourceKind = 'magnet' | 'url';

export interface QbitClientConfig {
  /** WebUI base URL, e.g. "http://localhost:8080". */
  baseUrl: string;
  /**
   * API key (qBittorrent >= 5.2). Sent as `Authorization: Bearer <key>`.
   * Preferred over username/password.
   */
  apiKey?: string;
  /** Cookie-session fallback credentials (any qBittorrent with WebUI). */
  username?: string;
  password?: string;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /**
   * Minimum supported WebAPI version, e.g. "2.11.9" (= qBittorrent 5.2.0).
   * Default "2.11.9": required for API-key auth and the dedicated metadata
   * endpoints. Lower values force the add-based inspection fallback.
   */
  minWebApiVersion?: string;
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export interface QbitVersionInfo {
  /** e.g. "v5.2.0" (raw string from /app/version). */
  qbtVersion: string;
  /** e.g. "2.11.9" (raw string from /app/webapiVersion). */
  webApiVersion: string;
}

/**
 * Which metadata-inspection strategy the connected server supports.
 * - fetchMetadata: qBittorrent >= 5.2 / WebAPI >= 2.11.9 dedicated endpoint.
 * - addStopCondition: older 5.x; inspect via add(stopped)+stopCondition parking.
 */
export type MetadataFeatureTier = 'fetchMetadata' | 'addStopCondition';

export interface QbitCapabilities extends QbitVersionInfo {
  tier: MetadataFeatureTier;
}

/** One file of a torrent as reported at inspection time. */
export interface InspectedFile {
  /** qBittorrent file index — canonical identity used for selection. */
  index: number;
  /** Path with platform-independent "/" separators (as qBittorrent reports). */
  path: string;
  size: number;
}

/**
 * Opaque reference returned by inspectTorrent and consumed by
 * commitTorrentSelection. Format: `vr_intake_<torrentHash>`.
 * The qBittorrent WebAPI provides no server-side intake token; this token is
 * minted locally and resolved through the adapter's intake registry.
 */
export type IntakeToken = string & { readonly __brand: 'IntakeToken' };

export interface InspectedTorrent {
  token: IntakeToken;
  name: string;
  /**
   * Canonical qBittorrent torrent id ("hash" field): infohash v1 for v1
   * torrents, truncated v2 hash for v2/hybrid torrents. Use this for all
   * subsequent lookups.
   */
  infoHash: string;
  infoHashV1: string | null;
  infoHashV2: string | null;
  files: InspectedFile[];
  totalSize: number;
  sourceKind: TorrentSourceKind;
  isPrivate: boolean | null;
}

export interface CommitSelectionInput {
  token: IntakeToken;
  /** qBittorrent file indexes the user wants. Must be non-empty subset. */
  selectedIndexes: number[];
  /** Unique Viking Relay job id. Used verbatim in tag/category vr_job_<jobId>. */
  jobId: string;
  /** Per-job save path. Supplied by caller; never invented here. */
  savePath: string;
}

export interface CommitSelectionResult {
  jobId: string;
  infoHash: string;
  infoHashV1: string | null;
  infoHashV2: string | null;
  name: string;
  savePath: string;
  /** Category proving Viking Relay ownership: vr_job_<jobId>. */
  category: string;
  /** Tag proving Viking Relay ownership: vr_job_<jobId>. */
  tag: string;
  selectedIndexes: number[];
}

/**
 * Semantic classification of a torrent state. UI heuristics only — this never
 * mutates qBittorrent behavior. Zero speed / no seeds are NOT fatal anywhere.
 */
export type ProgressClassification =
  | 'downloading'
  | 'waiting_for_peers'
  | 'metadata'
  | 'queued'
  | 'stopped'
  | 'completed'
  | 'checking'
  | 'moving'
  | 'error'
  | 'unknown';

/** Per-selected-file completion computed from the canonical selection list. */
export interface SelectedFilesCompletion {
  /** True when every SELECTED file reached progress 1. Deselected ignored. */
  complete: boolean;
  selectedCount: number;
  completedCount: number;
  incompleteSelectedIndexes: number[];
  wantedBytes: number;
  downloadedWantedBytes: number;
}

export interface JobProgress {
  jobId: string;
  infoHash: string;
  name: string;
  /** Raw qBittorrent state string, e.g. "downloading", "stalledDL". */
  stateRaw: string;
  classification: ProgressClassification;
  /**
   * Whole-torrent progress 0..1 INCLUDING deselected files. May never reach 1
   * when files are deselected — use selectedProgress/completion instead.
   */
  progress: number;
  /** downloadedWantedBytes / wantedBytes, 0..1. */
  selectedProgress: number;
  downloadedBytes: number;
  totalSize: number;
  /** Sum of sizes of SELECTED files. */
  wantedBytes: number;
  /** Sum of size*progress over SELECTED files. */
  downloadedWantedBytes: number;
  downloadSpeedBps: number;
  uploadSpeedBps: number;
  /** null when qBittorrent reports its infinity sentinel (8640000) or negative. */
  etaSeconds: number | null;
  seedsConnected: number;
  /** Seeds in swarm per trackers/DHT; null when unknown (-1). */
  seedsSwarm: number | null;
  peersConnected: number;
  /** Peers in swarm; null when unknown (-1). */
  peersSwarm: number | null;
  completion: SelectedFilesCompletion;
}

/** Proof requirements before any destructive operation. */
export interface OwnershipProof {
  /** Expected torrent hash. Mandatory. Compared case-insensitively. */
  expectedInfoHash: string;
  /** Expected ownership tag. Defaults to the job tag vr_job_<jobId>. */
  expectedTag?: string;
  /** Required prefix of the torrent save path. Defaults to recorded savePath. */
  expectedSavePathPrefix?: string;
}

/* ------------------------------------------------------------------ */
/* Internal registry records                                           */
/* ------------------------------------------------------------------ */

export interface IntakeRecord {
  token: IntakeToken;
  source: string;
  sourceKind: TorrentSourceKind;
  infoHash: string;
  infoHashV1: string | null;
  infoHashV2: string | null;
  name: string;
  files: InspectedFile[];
  totalSize: number;
  isPrivate: boolean | null;
  /**
   * True when fallback-tier inspection parked a real (stopped) intake torrent
   * inside qBittorrent that commit must adopt or discard must delete.
   */
  parkedTorrent: boolean;
  inspectedAt: number;
}

export interface JobRecord {
  jobId: string;
  infoHash: string;
  selectedIndexes: number[];
  savePath: string;
  tag: string;
  category: string;
  committedAt: number;
}

/* ------------------------------------------------------------------ */
/* Wire types (qBittorrent WebAPI responses)                           */
/* ------------------------------------------------------------------ */

/** Subset of GET /api/v2/torrents/info entries relevant to Viking Relay. */
export interface QbitTorrentInfo {
  hash: string;
  name: string;
  state: string;
  progress: number;
  size: number;
  total_size: number;
  downloaded: number;
  downloaded_session: number;
  completed: number;
  amount_left: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  num_seeds: number;
  num_complete: number;
  num_leechs: number;
  num_incomplete: number;
  category: string;
  tags: string[] | string;
  save_path: string;
  content_path: string;
  completion_on: number;
  added_on: number;
  availability: number;
  magnet_uri?: string;
  auto_tmm?: boolean;
}

/** Entry of GET /api/v2/torrents/files. */
export interface QbitTorrentFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
  availability: number;
  piece_range?: [number, number];
  /** Only present on the FIRST element; reflects whole-torrent finished state. */
  is_seed?: boolean;
}

/** Full-metadata response of POST /api/v2/torrents/fetchMetadata. */
export interface QbitFetchMetadataResponse {
  hash: string;
  infohash_v1: string;
  infohash_v2: string;
  info: {
    files: Array<{ path: string; length: number; priority?: number }>;
    length: number;
    name: string;
    piece_length: number;
    pieces_num: number;
    private: boolean;
  };
  trackers?: Array<{ url: string; tier: number }>;
  webseeds?: string[];
  created_by?: string;
  creation_date?: number;
  comment?: string;
}
