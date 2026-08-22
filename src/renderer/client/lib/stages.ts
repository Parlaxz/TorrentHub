/**
 * Derives the three display stages (DOWNLOAD / PACKAGE / UPLOAD TO VIKING)
 * and warning banners from an authoritative JobSnapshot. Pure — unit-tested.
 */

import type { DisplayStage } from "../components/StagePipeline";
import type { JobSnapshot } from "../types";

export function deriveDisplayStages(job: JobSnapshot): DisplayStage[] {
  const s = job.stages;

  const download: DisplayStage = {
    key: "download",
    title: "DOWNLOAD",
    state: s.download,
  };

  const packagingSkipped = s.packaging === "skipped";
  const pack: DisplayStage = {
    key: "package",
    title: "PACKAGE",
    state: s.packaging,
    note: packagingSkipped ? "Single file is uploaded directly" : undefined,
  };

  const upload: DisplayStage = {
    key: "upload",
    title: "UPLOAD TO VIKING",
    state: s.upload,
  };

  return [download, pack, upload];
}

export interface SpeedAdvisory {
  tone: "amber" | "blue";
  title: string;
  lines: string[];
}

/**
 * Low seeds / zero speed are WARNINGS, never failures.
 * Priority: explicit server hint first, then conservative telemetry heuristic.
 */
export function speedAdvisory(job: JobSnapshot): SpeedAdvisory | null {
  if (job.state !== "queued" && job.state !== "downloading") return null;
  const t = job.telemetry;
  if (!t) return null;

  if (job.hint === "waiting_for_peers" || t.seeds === 0) {
    return {
      tone: "blue",
      title: "Waiting for peers",
      lines: [
        `${t.seeds} seed${t.seeds === 1 ? "" : "s"} • ${t.peers} peer${t.peers === 1 ? "" : "s"}`,
        "Viking Relay will keep waiting.",
      ],
    };
  }

  if (job.hint === "slow" || t.seeds <= 2) {
    return {
      tone: "amber",
      title: "Few available seeds",
      lines: [
        `${t.seeds} seed${t.seeds === 1 ? "" : "s"} connected`,
        "This torrent may take a long time.",
      ],
    };
  }

  return null;
}
