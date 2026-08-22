import { describe, expect, it } from "vitest";
import type { HealthSnapshot, PairingInfo, TransferSnapshot } from "../../../src/renderer/server/bridge/types";
import {
  RADMIN_OFFLINE_MESSAGE,
  isRadminOffline,
  lowSpaceMessage,
  pairingCountdown,
  readinessRows,
  stageChips,
  storageRows,
  transferSummary,
} from "../../../src/renderer/server/domain/derive";

function job(overrides: Partial<TransferSnapshot> = {}): TransferSnapshot {
  return {
    id: "job-1",
    name: "The Show Complete",
    state: "downloading",
    zipRequired: true,
    telemetry: {
      progressPct: 74,
      downloadedBytes: 74,
      totalSelectedBytes: 100,
      speedBps: 38.7 * 1024 ** 2,
      etaSeconds: 95,
      seeds: 7,
      peers: 18,
      selectedComplete: false,
    },
    storage: {
      freeBytes: 221 * 1024 ** 3,
      remainingDownloadBytes: 26 * 1024 ** 3,
      zipReservationBytes: 100 * 1024 ** 3,
      safetyReserveBytes: null,
      projectedHeadroomBytes: 95 * 1024 ** 3,
      warning: "none",
    },
    ...overrides,
  };
}

describe("storageRows", () => {
  it("includes free, remaining torrent, ZIP reservation and projected headroom", () => {
    const rows = storageRows(job().storage!);
    expect(rows.map((r) => r.key)).toEqual(["free", "remaining", "zip", "headroom"]);
  });

  it("drops null entries and zero reservations", () => {
    const rows = storageRows({
      freeBytes: null,
      remainingDownloadBytes: null,
      zipReservationBytes: 0,
      safetyReserveBytes: null,
      projectedHeadroomBytes: null,
      warning: "none",
    });
    expect(rows).toEqual([]);
  });
});

describe("lowSpaceMessage", () => {
  it("maps warnings to strong copy", () => {
    expect(lowSpaceMessage("low")).toMatch(/getting low/i);
    expect(lowSpaceMessage("critical")).toMatch(/critically low/i);
    expect(lowSpaceMessage("none")).toBeNull();
  });
});

describe("transferSummary", () => {
  it("summarizes a downloading job", () => {
    const summary = transferSummary(job());
    expect(summary.name).toBe("The Show Complete");
    expect(summary.phase).toBe("download");
    expect(summary.percent).toBe(74);
    expect(summary.speedText).toMatch(/MB\/s/);
    expect(summary.seeds).toBe(7);
    expect(summary.peers).toBe(18);
    expect(summary.freeBytesText).toBe("221 GB");
  });

  it("pins percent to 100 once packaging/upload starts", () => {
    expect(transferSummary(job({ state: "packaging" })).percent).toBe(100);
    expect(transferSummary(job({ state: "uploading" })).phaseLabel).toBe("Upload");
  });

  it("maps terminal states", () => {
    expect(transferSummary(job({ state: "interrupted" })).phaseLabel).toBe("Interrupted");
    expect(transferSummary(job({ state: "complete" })).phaseLabel).toBe("Complete");
  });
});

describe("stageChips", () => {
  it("marks download active and later stages waiting during download", () => {
    const chips = stageChips(job());
    expect(chips.find((c) => c.phase === "download")?.status).toBe("active");
    expect(chips.find((c) => c.phase === "packaging")?.status).toBe("waiting");
  });

  it("marks download complete and packaging active during packaging", () => {
    const chips = stageChips(job({ state: "packaging" }));
    expect(chips.find((c) => c.phase === "download")?.status).toBe("complete");
    expect(chips.find((c) => c.phase === "packaging")?.status).toBe("active");
    expect(chips.find((c) => c.phase === "upload")?.status).toBe("waiting");
  });

  it("marks all complete when the job completes", () => {
    const chips = stageChips(job({ state: "complete" }));
    expect(chips.every((c) => c.status === "complete")).toBe(true);
  });
});

describe("readinessRows + offline", () => {
  const health = (radminState: HealthSnapshot["radmin"]["state"]): HealthSnapshot => ({
    online: true,
    address: "26.x.x.x:47821",
    radmin: { state: radminState, detail: radminState === "ok" ? "Connected" : "Disconnected" },
    qbit: { state: "ok", version: "5.2.1" },
    viking: { state: "ok", detail: "Ready" },
    storage: { freeBytes: 1.42 * 1024 ** 4, warning: "none" },
  });

  it("builds four status rows with readable details", () => {
    const rows = readinessRows(health("ok"));
    expect(rows.map((r) => r.label)).toEqual(["Radmin", "qBittorrent", "Viking", "Storage"]);
    expect(rows[1].detail).toBe("5.2.1");
    expect(rows[3].detail).toContain("free");
  });

  it("flags only hard radmin failures as offline with the fixed message", () => {
    expect(isRadminOffline(health("error"))).toBe(true);
    expect(isRadminOffline(health("ok"))).toBe(false);
    expect(isRadminOffline(health("warn"))).toBe(false);
    expect(isRadminOffline(health("unknown"))).toBe(false);
    expect(RADMIN_OFFLINE_MESSAGE).toBe(
      "Server is unavailable to Client until Radmin reconnects.",
    );
  });

  it("escalates storage warning into row severity", () => {
    const snapshot = health("ok");
    snapshot.storage.warning = "critical";
    expect(readinessRows(snapshot)[3].state).toBe("error");
  });
});

describe("pairingCountdown", () => {
  const pairing = (expiresInMs: number): PairingInfo => ({
    code: "K7RM-4Q2X",
    expiresAtEpochMs: 1_000_000 + expiresInMs,
    ttlSeconds: 600,
  });

  it("formats remaining time and urgency threshold", () => {
    const normal = pairingCountdown(pairing(9 * 60_000 + 42_000), 1_000_000);
    expect(normal.text).toBe("09:42");
    expect(normal.urgent).toBe(false);

    const urgent = pairingCountdown(pairing(40_000), 1_000_000);
    expect(urgent.text).toBe("00:40");
    expect(urgent.urgent).toBe(true);
  });

  it("expires at zero", () => {
    const expired = pairingCountdown(pairing(-1), 1_000_000);
    expect(expired.expired).toBe(true);
    expect(expired.text).toBe("00:00");
  });

  it("never shows more time than the issued TTL (stale tick guard)", () => {
    const skewed = pairingCountdown(pairing(600_000), 1_000_000 - 900);
    expect(skewed.text).toBe("10:00");
  });
});
