/**
 * Pure derivations from bridge snapshots to dashboard view models.
 * No React, no DOM — fully unit-testable.
 */

import type {
  HealthSnapshot,
  JobState,
  PairingInfo,
  SimpleHealthState,
  StorageView,
  TransferSnapshot,
} from "../bridge/types";
import { clampPercent, formatBytes, formatCountdown, formatSpeed } from "./format";

/* --------------------------------- storage --------------------------------- */

export interface StorageRow {
  key: "free" | "remaining" | "zip" | "headroom" | "reserve";
  label: string;
  bytes: number;
}

export function storageRows(storage: StorageView): StorageRow[] {
  const rows: StorageRow[] = [];
  if (storage.freeBytes !== null) rows.push({ key: "free", label: "Free", bytes: storage.freeBytes });
  if (storage.remainingDownloadBytes !== null)
    rows.push({ key: "remaining", label: "Remaining torrent", bytes: storage.remainingDownloadBytes });
  if (storage.zipReservationBytes !== null && storage.zipReservationBytes > 0)
    rows.push({ key: "zip", label: "ZIP reservation", bytes: storage.zipReservationBytes });
  if (storage.projectedHeadroomBytes !== null)
    rows.push({ key: "headroom", label: "Projected headroom", bytes: storage.projectedHeadroomBytes });
  return rows;
}

export const LOW_SPACE_MESSAGES = {
  low: "Storage is getting low. Transfers may fail if space runs out.",
  critical: "Storage critically low. Downloads and packaging may be aborted.",
} as const;

export function lowSpaceMessage(warning: StorageView["warning"]): string | null {
  if (warning === "low") return LOW_SPACE_MESSAGES.low;
  if (warning === "critical") return LOW_SPACE_MESSAGES.critical;
  return null;
}

/* ------------------------------ active transfer ----------------------------- */

export type TransferPhase =
  | "metadata"
  | "queued"
  | "download"
  | "packaging"
  | "upload"
  | "finalizing"
  | "complete"
  | "failed"
  | "cancelled"
  | "interrupted";

const STATE_TO_PHASE: Record<JobState, TransferPhase> = {
  reading_metadata: "metadata",
  awaiting_selection: "metadata",
  queued: "queued",
  downloading: "download",
  packaging: "packaging",
  uploading: "upload",
  finalizing: "finalizing",
  complete: "complete",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
};

export const PHASE_LABELS: Record<TransferPhase, string> = {
  metadata: "Reading torrent",
  queued: "Queued",
  download: "Download",
  packaging: "Packaging",
  upload: "Upload",
  finalizing: "Finishing up",
  complete: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

/** Phases shown as compact stage chips while a job runs. */
export const ACTIVE_STAGE_ORDER: readonly TransferPhase[] = [
  "download",
  "packaging",
  "upload",
] as const;

export interface StageChip {
  phase: TransferPhase;
  label: string;
  status: "waiting" | "active" | "complete" | "failed";
}

export function stageChips(job: TransferSnapshot): StageChip[] {
  const current = STATE_TO_PHASE[job.state];
  const currentIndex = ACTIVE_STAGE_ORDER.indexOf(current as (typeof ACTIVE_STAGE_ORDER)[number]);
  const terminalFailure =
    job.state === "failed" || job.state === "cancelled" || job.state === "interrupted";
  return ACTIVE_STAGE_ORDER.map((phase) => {
    let status: StageChip["status"];
    if (currentIndex === -1) {
      // Terminal/early states: nothing active; mark done only on complete.
      status = job.state === "complete" ? "complete" : "waiting";
    } else if (phase === current) {
      status = "active";
    } else {
      const idx = ACTIVE_STAGE_ORDER.indexOf(phase);
      status = idx < currentIndex ? "complete" : "waiting";
    }
    if (terminalFailure && ACTIVE_STAGE_ORDER.indexOf(phase) >= Math.max(currentIndex, 0)) {
      status = currentIndex >= 0 && ACTIVE_STAGE_ORDER.indexOf(phase) === currentIndex ? "failed" : "waiting";
    }
    return { phase, label: PHASE_LABELS[phase], status };
  });
}

export interface TransferSummary {
  id: string;
  name: string;
  phase: TransferPhase;
  phaseLabel: string;
  percent: number;
  speedText: string;
  seeds: number;
  peers: number;
  etaText: string;
  freeBytesText: string;
  warning: StorageView["warning"];
}

export function transferSummary(job: TransferSnapshot): TransferSummary {
  const phase = STATE_TO_PHASE[job.state];
  const telemetry = job.telemetry;
  const percent =
    phase === "complete" || phase === "upload" || phase === "packaging" || phase === "finalizing"
      ? 100
      : clampPercent(telemetry?.progressPct ?? 0);
  return {
    id: job.id,
    name: job.name,
    phase,
    phaseLabel: PHASE_LABELS[phase],
    percent,
    speedText: formatSpeed(telemetry?.speedBps ?? null),
    seeds: telemetry?.seeds ?? 0,
    peers: telemetry?.peers ?? 0,
    etaText: formatEtaSafe(telemetry?.etaSeconds),
    freeBytesText: formatBytes(job.storage?.freeBytes ?? null),
    warning: job.storage?.warning ?? "none",
  };
}

function formatEtaSafe(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

/* ---------------------------------- health ---------------------------------- */

export interface StatusRowVM {
  key: "radmin" | "qbittorrent" | "viking" | "storage";
  label: string;
  state: SimpleHealthState;
  detail: string;
}

export function readinessRows(health: HealthSnapshot): StatusRowVM[] {
  const radminDetail =
    health.radmin.state === "ok"
      ? health.radmin.detail || "Connected"
      : health.radmin.detail || "Disconnected";
  return [
    { key: "radmin", label: "Radmin", state: health.radmin.state, detail: radminDetail },
    {
      key: "qbittorrent",
      label: "qBittorrent",
      state: health.qbit.state,
      detail: health.qbit.version ? health.qbit.version : health.qbit.detail || "Unknown",
    },
    {
      key: "viking",
      label: "Viking",
      state: health.viking.state,
      detail: health.viking.detail || (health.viking.state === "ok" ? "Ready" : "Not ready"),
    },
    {
      key: "storage",
      label: "Storage",
      state:
        health.storage.warning === "critical"
          ? "error"
          : health.storage.warning === "low"
            ? "warn"
            : "ok",
      detail: `${formatBytes(health.storage.freeBytes)} free`,
    },
  ];
}

export const RADMIN_OFFLINE_MESSAGE =
  "Server is unavailable to Client until Radmin reconnects.";

export function isRadminOffline(health: HealthSnapshot): boolean {
  // Only a hard failure means "clients cannot reach us". A stopped or
  // not-yet-started relay has its own row detail; it is not a Radmin outage.
  return health.radmin.state === "error";
}

/* --------------------------------- pairing ---------------------------------- */

export interface PairingCountdownVM {
  text: string;
  expired: boolean;
  /** Under one minute left — render with urgency styling. */
  urgent: boolean;
}

export function pairingCountdown(pairing: PairingInfo, nowMs: number): PairingCountdownVM {
  // Clamp to the issued TTL so a stale tick never shows more time than granted.
  const msRemaining = Math.min(
    pairing.expiresAtEpochMs - nowMs,
    pairing.ttlSeconds * 1000,
  );
  const expired = msRemaining <= 0;
  return {
    text: expired ? "00:00" : formatCountdown(msRemaining),
    expired,
    urgent: !expired && msRemaining < 60_000,
  };
}
