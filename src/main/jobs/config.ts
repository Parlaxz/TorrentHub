import { VIKING_RELAY_TAG } from "./gateways.ts";

export interface JobEngineConfig {
  /** Root under which per-job directories are created: <root>/jobs/<jobId>/. */
  jobsRoot: string;
  /** Absolute path of the JSON history file. */
  historyFilePath: string;
  /** qBittorrent poll cadence. */
  pollIntervalMs: number;
  /** Sustained zero speed before the waiting_for_peers hint. Presentation only. */
  zeroSpeedMs: number;
  /** Speed below this (and above zero) sustained => slow hint. Presentation only. */
  slowSpeedBps: number;
  slowSpeedMs: number;
  /** Bytes that must remain free at all times. */
  safetyReserveBytes: number;
  /** Projected headroom below this triggers a 'low' storage warning. */
  lowHeadroomBytes: number;
  /** Max jobs kept in history. */
  historyLimit: number;
  /** Ownership tag handed to the torrent gateway. */
  ownershipTag: string;
}

export const DEFAULT_CONFIG: Omit<JobEngineConfig, "jobsRoot" | "historyFilePath"> = {
  pollIntervalMs: 1000,
  zeroSpeedMs: 60_000,
  slowSpeedBps: 256 * 1024,
  slowSpeedMs: 120_000,
  safetyReserveBytes: 1024 * 1024 * 1024,
  lowHeadroomBytes: 512 * 1024 * 1024,
  historyLimit: 100,
  ownershipTag: VIKING_RELAY_TAG,
};

export function resolveConfig(overrides: Partial<JobEngineConfig>): JobEngineConfig {
  const { jobsRoot, historyFilePath } = overrides;
  if (!jobsRoot) throw new Error("JobEngineConfig.jobsRoot is required");
  if (!historyFilePath) throw new Error("JobEngineConfig.historyFilePath is required");
  return { ...DEFAULT_CONFIG, ...overrides, jobsRoot, historyFilePath };
}
