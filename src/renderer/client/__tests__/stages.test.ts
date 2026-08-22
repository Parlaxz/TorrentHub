import { describe, expect, it } from "vitest";
import { deriveDisplayStages, speedAdvisory } from "../lib/stages";
import type { DownloadTelemetry, JobSnapshot, StageMap } from "../types";

function stages(o: Partial<StageMap> = {}): StageMap {
  return {
    metadata: "complete",
    selection: "complete",
    preflight: "complete",
    download: "waiting",
    packaging: "waiting",
    upload: "waiting",
    finalize: "waiting",
    cleanup: "waiting",
    ...o,
  };
}

function tel(o: Partial<DownloadTelemetry> = {}): DownloadTelemetry {
  return {
    progressPct: 81,
    downloadedBytes: 74.3 * 1024 ** 3,
    totalSelectedBytes: 91.7 * 1024 ** 3,
    speedBps: 47.3 * 1024 ** 2,
    etaSeconds: 368,
    seeds: 7,
    peers: 18,
    selectedComplete: false,
    ...o,
  };
}

function job(o: Partial<Omit<JobSnapshot, "stages">> & { stageOverrides?: Partial<StageMap> } = {}): JobSnapshot {
  const { stageOverrides, ...rest } = o;
  return {
    id: "j1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    state: "downloading",
    source: { kind: "magnet", value: "magnet:?xt=urn:btih:abc" },
    stages: stages(stageOverrides),
    metadata: { name: "Test Torrent", files: [], totalSizeBytes: 0 },
    telemetry: null,
    storage: null,
    hint: null,
    error: null,
    result: null,
    ...rest,
  };
}

describe("deriveDisplayStages", () => {
  it("exposes exactly DOWNLOAD / PACKAGE / UPLOAD TO VIKING", () => {
    const s = deriveDisplayStages(job());
    expect(s.map((x) => x.title)).toEqual(["DOWNLOAD", "PACKAGE", "UPLOAD TO VIKING"]);
  });

  it("labels skipped packaging as a direct single-file upload", () => {
    const s = deriveDisplayStages(job({ stageOverrides: { packaging: "skipped" }, zipRequired: false }));
    expect(s[1].state).toBe("skipped");
    expect(s[1].note).toMatch(/uploaded directly/i);
  });
});

describe("speedAdvisory — warnings, never failures", () => {
  it("shows waiting-for-peers for zero seeds", () => {
    const a = speedAdvisory(job({ telemetry: tel({ seeds: 0, peers: 4, speedBps: 0 }) }));
    expect(a).not.toBeNull();
    expect(a!.title).toBe("Waiting for peers");
    expect(a!.lines.join(" ")).toContain("Viking Relay will keep waiting");
  });

  it("shows few-seeds warning on the slow hint", () => {
    const a = speedAdvisory(job({ hint: "slow", telemetry: tel({ seeds: 1 }) }));
    expect(a!.tone).toBe("amber");
    expect(a!.title).toBe("Few available seeds");
  });

  it("stays quiet while download is healthy", () => {
    expect(speedAdvisory(job({ telemetry: tel() }))).toBeNull();
  });

  it("does not advise outside active download states", () => {
    expect(
      speedAdvisory(job({ state: "complete", stageOverrides: { download: "complete" }, telemetry: tel({ seeds: 0 }) })),
    ).toBeNull();
  });
});
