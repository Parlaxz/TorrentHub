// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActiveJobScreen } from "../../../src/renderer/client/screens/ActiveJobScreen";
import type { DownloadTelemetry, JobSnapshot, StageMap, StorageView } from "../../../src/renderer/client/types";

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

function store(o: Partial<StorageView> = {}): StorageView {
  return {
    freeBytes: 221.4 * 1024 ** 3,
    remainingDownloadBytes: 17.4 * 1024 ** 3,
    zipReservationBytes: 91.7 * 1024 ** 3,
    safetyReserveBytes: 5 * 1024 ** 3,
    projectedHeadroomBytes: 107.3 * 1024 ** 3,
    warning: "none",
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
    metadata: { name: "Big Pack", files: [], totalSizeBytes: 0 },
    telemetry: null,
    storage: null,
    hint: null,
    error: null,
    result: null,
    ...rest,
  };
}

afterEach(cleanup);

describe("ActiveJobScreen — stage rendering", () => {
  it("renders an active download with bar, seeds and peers — no fake overall percent", () => {
    render(
      <ActiveJobScreen
        job={job({ stageOverrides: { download: "active" }, telemetry: tel(), storage: store() })}
        pollStatus="live"
      />,
    );
    expect(screen.getByText("DOWNLOAD")).toBeTruthy();
    expect(screen.getByText("PACKAGE")).toBeTruthy();
    expect(screen.getByText("UPLOAD TO VIKING")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Download progress" })).toBeTruthy();
    expect(screen.getByText(/MB\/s/)).toBeTruthy();
    expect(screen.getByText("Seeds")).toBeTruthy();
    expect(screen.getByText("Peers")).toBeTruthy();
    // Server-authoritative storage rows.
    expect(screen.getByText("Projected headroom")).toBeTruthy();
  });

  it("marks a completed stage with a checkmark", () => {
    const { container } = render(
      <ActiveJobScreen job={job({ stageOverrides: { download: "complete" } })} pollStatus="live" />,
    );
    expect(container.textContent).toContain("✓");
  });

  it("shows skipped packaging for single-file direct upload", () => {
    render(<ActiveJobScreen job={job({ stageOverrides: { packaging: "skipped" }, zipRequired: false })} pollStatus="live" />);
    expect(screen.getByText("Skipped")).toBeTruthy();
    expect(screen.getByText(/uploaded directly/i)).toBeTruthy();
  });

  it("shows a failed upload with a Retry Upload affordance", () => {
    const onRetryUpload = vi.fn();
    render(
      <ActiveJobScreen
        job={job({
          state: "failed",
          stageOverrides: { download: "complete", packaging: "complete", upload: "failed" },
          error: { kind: "upload", message: "Viking rejected part 3" },
        })}
        pollStatus="live"
        onRetryUpload={onRetryUpload}
      />,
    );
    expect(screen.getByText(/Viking rejected part 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry Upload" }));
    expect(onRetryUpload).toHaveBeenCalledTimes(1);
  });
});

describe("ActiveJobScreen — low seeds are warnings, not failures", () => {
  it("zero seeds shows a waiting advisory and never FAILED", () => {
    render(
      <ActiveJobScreen
        job={job({
          stageOverrides: { download: "active" },
          telemetry: tel({ seeds: 0, peers: 4, speedBps: 0 }),
          hint: "waiting_for_peers",
        })}
        pollStatus="live"
      />,
    );
    expect(screen.getByText(/Waiting for peers/)).toBeTruthy();
    expect(screen.getByText(/Viking Relay will keep waiting/)).toBeTruthy();
    expect(screen.queryByText(/Failed/)).toBeNull();
  });

  it("few seeds shows the slow-download warning", () => {
    render(
      <ActiveJobScreen
        job={job({
          stageOverrides: { download: "active" },
          telemetry: tel({ seeds: 1, speedBps: 823 * 1024 }),
          hint: "slow",
        })}
        pollStatus="live"
      />,
    );
    expect(screen.getByText(/Few available seeds/)).toBeTruthy();
    expect(screen.getByText(/may take a long time/)).toBeTruthy();
  });

  it("surfaces server storage warnings at both levels", () => {
    const { unmount } = render(
      <ActiveJobScreen job={job({ storage: store({ warning: "low" }) })} pollStatus="live" />,
    );
    expect(screen.getByText(/Server storage running low/)).toBeTruthy();
    unmount();

    render(<ActiveJobScreen job={job({ storage: store({ warning: "critical" }) })} pollStatus="live" />);
    expect(screen.getByText(/critically low/)).toBeTruthy();
  });

  it("announces reconnecting without implying the job died", () => {
    render(
      <ActiveJobScreen
        job={job({ stageOverrides: { download: "active" }, telemetry: tel() })}
        pollStatus="reconnecting"
      />,
    );
    expect(screen.getAllByText(/Reconnecting/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/continues on the server/)).toBeTruthy();
  });
});
