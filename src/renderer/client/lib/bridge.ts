/**
 * INTEGRATION SEAM — expected client-side bridge surface.
 *
 * The renderer never touches Node, never uses localStorage for secrets, and
 * only reaches the server through this interface. Screens receive it via
 * props/context; only THIS file knows where it comes from.
 *
 * Relationship to the real preload contract (`src/shared/ipc.ts`):
 *  - `window.vikingRelay` is typed there as VikingRelayBridge
 *    (getState/setMode/updateSettings/secrets) and must NOT be redeclared
 *    here — that would be a conflicting global declaration.
 *  - The job/pairing methods below are expected to arrive either as an
 *    extension of the preload bridge or as a main-side adapter over the REST
 *    ApiRoutes in `src/shared/api.ts` (pair/intake/metadata/jobs/cancel/
 *    retry/history; CreateJobRequest{intakeId, selectedIndex}; error envelope
 *    with `storage_blocked`). Adapt in this file ONLY.
 *
 * All methods reject with Error on failure. Connection/token storage is owned
 * by main (safeStorage); the renderer only passes values through.
 */

import type {
  HistoryEntry,
  IntakeDraftView,
  JobGoal,
  JobSnapshot,
  StoragePreflight,
} from "../types";

export interface SavedConnection {
  host: string;
  port: number;
}

export type ConnectionState = "connected" | "reconnecting" | "offline" | "unpaired";

export interface ConnectionStatus {
  state: ConnectionState;
  host?: string;
  port?: number;
}

export interface PairParams {
  host: string;
  port: number;
  code: string;
}

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** A saved friend: paired-client identity plus an optional local nickname. */
export interface Friend {
  clientId: string;
  name: string;
  alias?: string;
}

/** Sender-side view of a link previously sent to a friend. */
export interface SentDirectJobStatus {
  id: string;
  targetClientId: string;
  targetName: string;
  /** Short source label for the downloads list after a restart. */
  sourcePreview?: string | null;
  /** File indexes the sender picked; null = whole torrent. */
  selection?: number[] | null;
  state: string;
  /** Last receiver-reported progress; null until the first report lands. */
  progress: {
    progressPct: number | null;
    dlSpeedBps: number | null;
    downloadedBytes: number | null;
    totalBytes: number | null;
    updatedAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface VikingBridge {
  /** Saved server connection (host/port only — tokens stay in main). */
  getConnection(): Promise<SavedConnection | null>;
  pair(params: PairParams): Promise<BridgeResult<SavedConnection>>;
  forgetConnection(): Promise<void>;

  connectionStatus(): Promise<ConnectionStatus>;
  onConnectionChanged(cb: (status: ConnectionStatus) => void): () => void;

  /** Submit a magnet URI or HTTP(S) .torrent URL. Returns the draft job id. */
  createIntake(input: string): Promise<{ jobId: string }>;
  getDraft(jobId: string): Promise<IntakeDraftView>;
  cancelJob(jobId: string): Promise<void>;

  /**
   * Ad-hoc storage check. Does not start the job.
   * The goal decides whether a temporary ZIP is included in the peak.
   */
  preflightSelection(
    jobId: string,
    fileIndexes: number[],
    goal?: JobGoal,
  ): Promise<BridgeResult<StoragePreflight>>;

  /** Commit the selection and start the transfer. */
  startJob(
    jobId: string,
    options: {
      selection: number[];
      goal: JobGoal;
      cleanup?: { deleteTorrent?: boolean; deleteFiles?: boolean; deleteZip?: boolean };
    },
  ): Promise<void>;

  /** All jobs for this client (drafts, downloads, orders). */
  listJobs(): Promise<JobSnapshot[]>;

  /** Storage check for a bundle order made from parked downloads. */
  preflightOrder(jobIds: string[]): Promise<StoragePreflight>;
  /** Create the bundle order and start it. */
  createOrder(
    jobIds: string[],
    cleanup?: { deleteTorrent?: boolean; deleteFiles?: boolean; deleteZip?: boolean },
  ): Promise<{ id: string }>;
  /** Stop an active order and remove it from the list. */
  dismissJob(jobId: string): Promise<void>;
  /** Delete a parked download and its files. */
  discardJob(jobId: string): Promise<void>;

  getJob(jobId: string): Promise<JobSnapshot>;
  retryPackaging(jobId: string): Promise<void>;
  retryUpload(jobId: string): Promise<void>;

  listHistory(): Promise<HistoryEntry[]>;

  /** Safe clipboard write exposed by preload. Returns false if unavailable. */
  copyText(text: string): Promise<boolean>;

  /** Clipboard read via the main process. Returns '' when unavailable/empty. */
  readText(): Promise<string>;

  /** Other paired clients on the server (potential friends). */
  clientsList(): Promise<Array<{ clientId: string; name: string }>>;
  /** Client-to-client: send a link (and chosen file indexes) to a friend. */
  sendToFriend(
    source: string,
    targetClientId: string,
    selection?: number[],
  ): Promise<BridgeResult<{ id: string }>>;
  friendsGet(): Promise<Friend[]>;
  friendsAdd(friend: { clientId: string; name: string }): Promise<Friend[]>;
  friendsRename(clientId: string, alias: string): Promise<BridgeResult<Friend[]>>;
  friendsRemove(clientId: string): Promise<Friend[]>;
  /** Links this client sent (newest first). Call on demand — never polled. */
  directJobsSent(): Promise<SentDirectJobStatus[]>;
  /** One-shot status check for a single sent link. */
  directJobStatus(id: string): Promise<SentDirectJobStatus>;
}

/**
 * Injection point. Deliberately NOT `window.vikingRelay` (owned by
 * src/shared/ipc.ts). Integration installs the adapter under this key, or
 * getBridge() is rewritten to construct one over the real preload API.
 */
const BRIDGE_KEY = "vikingClientBridge";

let cached: VikingBridge | null | undefined;

/** Returns the client bridge, or null when no adapter has been installed. */
export function getBridge(): VikingBridge | null {
  if (cached === undefined) {
    if (typeof window === "undefined") {
      cached = null;
    } else {
      const w = window as unknown as Record<string, unknown>;
      cached = (w[BRIDGE_KEY] as VikingBridge | undefined) ?? null;
    }
  }
  return cached;
}

/** Test/integration helper: install or remove the bridge for this session. */
export function setBridgeForTests(bridge: VikingBridge | null): void {
  cached = bridge;
  if (typeof window !== "undefined") {
    const w = window as unknown as Record<string, unknown>;
    if (bridge) w[BRIDGE_KEY] = bridge;
    else delete w[BRIDGE_KEY];
  }
}
