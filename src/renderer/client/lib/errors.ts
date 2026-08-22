/**
 * Error classification → specific, actionable UI states.
 *
 * INTEGRATION SEAM: A5's FailureKind is coarse (metadata/packaging/upload/…).
 * Intake-side failures (qBittorrent down, unsupported version, duplicate,
 * bad torrent) currently arrive as kind:"metadata" with a message. We match
 * on structured fields first, then conservative message patterns. Replace the
 * heuristics with structured error codes when shared contracts land.
 */

import type { JobError, JobRecord } from "../types";

export type ClientErrorKind =
  | "server_unreachable"
  | "qbittorrent_unavailable"
  | "qbittorrent_unsupported"
  | "bad_torrent"
  | "metadata_unavailable"
  | "duplicate_torrent"
  | "insufficient_disk"
  | "packaging_failed"
  | "upload_failed"
  | "cancelled"
  | "interrupted"
  | "unknown";

export function classifyJobFailure(rec: Pick<JobRecord, "state" | "error">): ClientErrorKind {
  if (rec.state === "interrupted") return "interrupted";
  if (rec.state === "cancelled") return "cancelled";
  const err = rec.error;
  if (!err) return rec.state === "failed" ? "unknown" : "unknown";
  return classifyJobError(err);
}

export function classifyJobError(err: JobError): ClientErrorKind {
  if (err.insufficientSpace || err.kind === "storage_preflight" || err.kind === "storage_before_packaging") {
    return "insufficient_disk";
  }
  switch (err.kind) {
    case "packaging":
      return "packaging_failed";
    case "upload":
      return "upload_failed";
    case "finalize":
      return "upload_failed";
    case "download":
      return "unknown";
    case "metadata":
      break; // fall through to message heuristics
  }
  return classifyMessage(err.message);
}

export function classifyMessage(message: string): ClientErrorKind {
  const m = (message || "").toLowerCase();
  if (/duplicate|already (added|exists)|unmanaged/.test(m)) return "duplicate_torrent";
  if (/unsupported|version/.test(m) && /qbittorrent|qbit|libtorrent/.test(m)) return "qbittorrent_unsupported";
  if (/qbittorrent.*(unavailable|not running|unreachable|refused)|(connect|econnrefused).*(qbittorrent)/.test(m))
    return "qbittorrent_unavailable";
  if (/invalid|corrupt|parse|bad torrent|not a (valid )?torrent|magnet/.test(m)) return "bad_torrent";
  if (/metadata|info ?hash|no peers|timed? ?out/.test(m)) return "metadata_unavailable";
  if (/disk|space|storage|enospc/.test(m)) return "insufficient_disk";
  if (/network|econnrefused|refused|etimedout|fetch|socket|offline/.test(m)) return "server_unreachable";
  return "unknown";
}

export interface ErrorPresentation {
  title: string;
  detail: string;
  /** Retry Packaging / Retry Upload affordance. */
  retry?: "packaging" | "upload";
}

export function presentError(kind: ClientErrorKind, rawMessage?: string | null): ErrorPresentation {
  switch (kind) {
    case "server_unreachable":
      return {
        title: "Server unreachable",
        detail:
          rawMessage ||
          "Viking Relay could not reach the relay server. Check that it is running and reachable, then reconnect.",
      };
    case "qbittorrent_unavailable":
      return {
        title: "qBittorrent unavailable",
        detail:
          rawMessage ||
          "The server cannot reach qBittorrent. Make sure qBittorrent is running with its WebUI enabled, then try again.",
      };
    case "qbittorrent_unsupported":
      return {
        title: "Unsupported qBittorrent version",
        detail:
          rawMessage ||
          "The server's qBittorrent version is not supported. Update qBittorrent on the server and try again.",
      };
    case "bad_torrent":
      return {
        title: "Invalid torrent",
        detail: rawMessage || "That magnet link or torrent URL could not be used. Double-check it and try again.",
      };
    case "metadata_unavailable":
      return {
        title: "Metadata unavailable",
        detail:
          rawMessage ||
          "No peers provided the torrent metadata in time. Check the torrent's health and try again.",
      };
    case "duplicate_torrent":
      return {
        title: "Duplicate torrent",
        detail:
          rawMessage ||
          "This torrent already exists in the server's qBittorrent but is not managed by Viking Relay. Remove it from qBittorrent (or add its files manually), then try again.",
      };
    case "insufficient_disk":
      return {
        title: "Not enough server storage",
        detail:
          rawMessage ||
          "The server does not have enough free space for this job, including the temporary ZIP and safety reserve. Free up space or select fewer files.",
      };
    case "packaging_failed":
      return {
        title: "Packaging failed",
        detail: rawMessage || "The server could not package the selected files into a ZIP.",
        retry: "packaging",
      };
    case "upload_failed":
      return {
        title: "Viking upload failed",
        detail: rawMessage || "The upload to Viking did not complete.",
        retry: "upload",
      };
    case "cancelled":
      return { title: "Cancelled", detail: rawMessage || "This job was cancelled." };
    case "interrupted":
      return {
        title: "Previous job was interrupted",
        detail:
          rawMessage ||
          "Previous job was interrupted when Viking Relay closed unexpectedly. Automatic resume is not supported. The server has cleaned up this job's partial files; you can safely start a new torrent.",
      };
    default:
      return {
        title: "Something went wrong",
        detail: rawMessage || "An unexpected error occurred. Try again, or check the server status.",
      };
  }
}
