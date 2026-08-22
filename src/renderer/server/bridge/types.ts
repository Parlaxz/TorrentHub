/**
 * Viking Relay — Server Mode renderer INTERNAL contracts.
 *
 * These types describe the surface the renderer expects from preload/main.
 * They are intentionally self-contained (no imports from main/shared) so the
 * renderer lane can compile before shared contracts land. When the real
 * preload contract arrives, adapt it to `VikingRelayServerBridge` in ONE place
 * (`bridge/serverBridge.ts`) — screens never touch window directly.
 *
 * Hard rules encoded here:
 *  - Renderer never touches fs / net directly; everything is an IPC call.
 *  - Secrets are write-only: the bridge returns "is set" booleans, never
 *    plaintext, unless an explicit reveal capability is used deliberately.
 *  - Optional backend features are gated by `ServerCapabilities` so the UI
 *    only offers actions that truly exist (no fake recovery / fake tests).
 */

/* ---------------------------------- storage --------------------------------- */

export interface DriveInfo {
  /** e.g. "D:" on Windows or a mount path elsewhere. */
  root: string;
  label?: string | null;
  kind: "fixed" | "removable" | "network" | "unknown";
  totalBytes: number;
  freeBytes: number;
}

export interface WorkingFolderStatus {
  path: string | null;
  drive: DriveInfo | null;
  writable: boolean;
  /** Backend-provided problem, e.g. "path is not writable". */
  error?: string | null;
}

/* ---------------------------------- radmin ---------------------------------- */

export interface RadminInterfaceInfo {
  /** Stable id the backend understands (passed back verbatim). */
  id: string;
  name: string;
  ipv4: string;
}

export type RadminProblem = "not_installed" | "disconnected" | "ambiguous" | "unknown";

export interface RadminStatus {
  detected: boolean;
  connected: boolean;
  adapterName?: string | null;
  ipv4?: string | null;
  /** True when more than one candidate interface exists and none is pinned. */
  ambiguous?: boolean;
  /** Safe interfaces to choose from when ambiguous. */
  candidates?: RadminInterfaceInfo[];
  /** Id of the user-pinned interface (settings), if any. */
  selectedId?: string | null;
  problem?: RadminProblem | null;
}

/* ------------------------------- qbittorrent -------------------------------- */

export type QbitProbeReason =
  | "not_running"
  | "auth"
  | "version_too_old"
  | "invalid_url"
  | "unknown";

export interface QbitProbeResult {
  ok: boolean;
  version?: string | null;
  supported?: boolean;
  reason?: QbitProbeReason;
  message?: string;
}

/* ----------------------------------- viking --------------------------------- */

export type VikingMode = "anonymous" | "user_hash" | "unconfigured";

export interface VikingConfigView {
  mode: VikingMode;
  /** Backend says anonymous upload is allowed at all. */
  supportsAnonymous: boolean;
  /** Backend requires a user hash (anonymous not permitted). */
  requiresUserHash: boolean;
  /** Masked hint of the stored hash, e.g. "a1b2…9f". Null when unset. */
  userHashMasked?: string | null;
}

/** Only produced when backend exposes a non-destructive validation. */
export interface VikingTestResult {
  ok: boolean;
  message: string;
}

/* ---------------------------------- pairing --------------------------------- */

export interface PairingInfo {
  /** Human-readable code, e.g. "K7RM-4Q2X". Not a bearer token. */
  code: string;
  /** Epoch ms when the code stops being accepted. */
  expiresAtEpochMs: number;
  ttlSeconds: number;
}

/** A currently-paired client. Pairing persists until explicitly revoked. */
export interface PairedClientInfo {
  clientId: string;
  name: string;
  createdAt: string;
}

/** A download sent to a paired client ("friend mode"). */
export interface SentDirectJob {
  id: string;
  source: string;
  sourceKind: string;
  targetName: string;
  state: "queued" | "accepted" | "declined";
  createdAt: string;
}

/* ---------------------------------- health ---------------------------------- */

export type SimpleHealthState = "ok" | "warn" | "error" | "unknown";

export interface StorageSummary {
  freeBytes: number | null;
  warning: "none" | "low" | "critical";
}

export interface HealthSnapshot {
  online: boolean;
  /** "26.x.x.x:47821" style listen address, null while offline. */
  address: string | null;
  radmin: { state: SimpleHealthState; detail?: string | null };
  qbit: { state: SimpleHealthState; version?: string | null; detail?: string | null };
  viking: { state: SimpleHealthState; detail?: string | null };
  storage: StorageSummary;
}

/* ----------------------------------- jobs ----------------------------------- */
/*
 * Structurally aligned with A5 job-engine types (src/main/jobs/types.ts).
 * Re-declared here so the renderer lane stays decoupled during parallel work.
 */

export type JobState =
  | "reading_metadata"
  | "awaiting_selection"
  | "queued"
  | "downloading"
  | "packaging"
  | "uploading"
  | "finalizing"
  | "complete"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface DownloadTelemetry {
  progressPct: number;
  downloadedBytes: number;
  totalSelectedBytes: number;
  speedBps: number;
  etaSeconds: number | null;
  seeds: number;
  peers: number;
  selectedComplete: boolean;
  at?: number;
}

export interface StorageView {
  freeBytes: number | null;
  remainingDownloadBytes: number | null;
  zipReservationBytes: number | null;
  safetyReserveBytes: number | null;
  projectedHeadroomBytes: number | null;
  warning: "none" | "low" | "critical";
}

export interface TransferSnapshot {
  id: string;
  name: string;
  state: JobState;
  zipRequired: boolean;
  telemetry: DownloadTelemetry | null;
  storage: StorageView | null;
  error?: string | null;
}

export interface HistoryEntry {
  id: string;
  name: string;
  finalState: Extract<JobState, "complete" | "failed" | "cancelled" | "interrupted">;
  url?: string | null;
  /** Direct download link resolved from the provider, when available. */
  directUrl?: string | null;
  finishedAt: string;
  errorKind?: string | null;
  /** Human-readable failure reason; present on failed/interrupted jobs. */
  errorMessage?: string | null;
  archived?: boolean;
}

/* --------------------------------- settings --------------------------------- */

export interface AppSettings {
  workingFolderPath: string | null;
  /** Pinned Radmin interface id, null = automatic/single. */
  radminInterfaceId: string | null;
  relayPort: number;
  qbitWebUiUrl: string;
  /** Write-only secret: true once stored. Never returned as plaintext. */
  qbitApiKeySet: boolean;
  vikingUserHashSet: boolean;
  startWithWindows: boolean;
  preventSleepDuringTransfers: boolean;
  /** Post-upload cleanup defaults (per-job overrides exist at Start time). */
  cleanupDeleteTorrent: boolean;
  cleanupDeleteFiles: boolean;
  cleanupDeleteZip: boolean;
}

export type SettingsPatch = Partial<
  Pick<
    AppSettings,
    | "workingFolderPath"
    | "radminInterfaceId"
    | "relayPort"
    | "qbitWebUiUrl"
    | "startWithWindows"
    | "preventSleepDuringTransfers"
    | "cleanupDeleteTorrent"
    | "cleanupDeleteFiles"
    | "cleanupDeleteZip"
  >
>;

/* ------------------------------- capabilities ------------------------------- */

export interface ServerCapabilities {
  /** Native folder picker via main. */
  chooseWorkingFolderDialog: boolean;
  /** Non-destructive Viking credential validation exists. */
  testViking: boolean;
  /** Backend can register autostart. */
  startWithWindows: boolean;
  /** Main implements powerSaveBlocker during transfers. */
  powerSaveBlocker: boolean;
  /** Interrupted-job actions that truly exist server-side. */
  dismissInterruptedJob: boolean;
  cleanJobData: boolean;
  openQBittorrentWebUi: boolean;
  /** Main intercepts window close into hide-to-tray. */
  closeToTray: boolean;
  /** Deliberate cleartext reveal of a stored secret is available. */
  revealSecrets: boolean;
}

/* ---------------------------------- bridge ---------------------------------- */

export type Unsubscribe = () => void;

export interface VikingRelayServerBridge {
  /* setup + health */
  getWorkingFolderStatus(): Promise<WorkingFolderStatus>;
  /** Main validates writability + drive stats; renderer never touches fs. */
  setWorkingFolderPath(path: string): Promise<WorkingFolderStatus>;
  chooseWorkingFolder(): Promise<WorkingFolderStatus>;
  getRadminStatus(): Promise<RadminStatus>;
  selectRadminInterface(id: string): Promise<RadminStatus>;
  probeQbittorrent(config: { webUiUrl: string; apiKey?: string }): Promise<QbitProbeResult>;
  getVikingConfig(): Promise<VikingConfigView>;
  setVikingUserHash(hash: string): Promise<VikingConfigView>;
  testViking?(): Promise<VikingTestResult>;

  /* lifecycle */
  startServer(): Promise<HealthSnapshot>;
  stopServer(): Promise<void>;
  getHealth(): Promise<HealthSnapshot>;

  /* pairing */
  generatePairingCode(): Promise<PairingInfo>;
  /** Active paired clients; empty on older builds. */
  listPairedClients?(): Promise<PairedClientInfo[]>;
  /** Server-side disconnect: revokes the client's bearer token. */
  revokePairedClient?(clientId: string): Promise<{ removed: boolean }>;
  /** Send a magnet/link to a paired client's local download queue. */
  sendDirectJob?(source: string, targetClientId: string): Promise<{ ok: boolean; id?: string; error?: string }>;
  listDirectJobs?(): Promise<SentDirectJob[]>;
  /**
   * Wipes the server profile (settings, secrets, pairings) and returns the
   * app to first-run onboarding. Destructive — UI must confirm first.
   */
  resetProfile?(): Promise<{ ok: boolean }>;

  /* jobs */
  getActiveJob(): Promise<TransferSnapshot | null>;
  getHistory(limit: number): Promise<HistoryEntry[]>;
  getArchivedHistory(limit: number): Promise<HistoryEntry[]>;
  setJobArchived?(jobId: string, archived: boolean): Promise<void>;
  /** Copies text to the clipboard from the main process. */
  copyText?(text: string): Promise<boolean>;
  dismissInterruptedJob?(jobId: string): Promise<void>;
  cleanJobData?(jobId: string): Promise<void>;
  openQBittorrentWebUi?(): Promise<void>;

  /* settings + secrets */
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: SettingsPatch): Promise<AppSettings>;
  setQbitApiKey(apiKey: string): Promise<{ ok: boolean }>;
  setVikingUserHashSetting?(hash: string): Promise<{ ok: boolean }>;
  /** Explicit, deliberate reveal — the ONLY path plaintext may take. */
  revealQbitApiKey?(): Promise<string>;

  /* capabilities + lifecycle UX support */
  capabilities(): Promise<ServerCapabilities>;
  /** Ask main to quit; main decides whether confirmation is needed. */
  requestAppExit(): Promise<void>;

  /* events */
  onHealth(cb: (snapshot: HealthSnapshot) => void): Unsubscribe;
  onJob(cb: (job: TransferSnapshot | null) => void): Unsubscribe;
  onPairing(cb: (pairing: PairingInfo | null) => void): Unsubscribe;
}
