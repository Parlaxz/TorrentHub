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

import type { HistoryEntry, IntakeDraftView, JobSnapshot, StoragePreflight } from "../types";

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
   * Confirm selection using canonical qBittorrent FILE INDEXES.
   * Server responds with authoritative storage preflight.
   */
  confirmSelection(
    jobId: string,
    fileIndexes: number[],
    cleanup?: { deleteTorrent?: boolean; deleteFiles?: boolean; deleteZip?: boolean },
  ): Promise<BridgeResult<StoragePreflight>>;

  startJob(jobId: string): Promise<void>;
  getJob(jobId: string): Promise<JobSnapshot>;
  retryPackaging(jobId: string): Promise<void>;
  retryUpload(jobId: string): Promise<void>;

  listHistory(): Promise<HistoryEntry[]>;

  /** Safe clipboard write exposed by preload. Returns false if unavailable. */
  copyText(text: string): Promise<boolean>;
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
