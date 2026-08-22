// @vitest-environment jsdom
/**
 * Dashboard component tests: status visibility, pairing, active transfer,
 * storage warnings, interrupted state, secrets handling, exit confirmation.
 */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MockServerBridge } from "../../../src/renderer/server/bridge/mockServerBridge";
import type { HistoryEntry, TransferSnapshot } from "../../../src/renderer/server/bridge/types";
import { RuntimeProvider } from "../../../src/renderer/server/state/RuntimeContext";
import { Dashboard } from "../../../src/renderer/server/screens/Dashboard";
import { assertNoPlaintextSecrets } from "../../../src/renderer/server/domain/secrets";

afterEach(cleanup);

function renderDashboard(bridge: MockServerBridge) {
  return render(
    <RuntimeProvider bridge={bridge}>
      <Dashboard bridge={bridge} />
    </RuntimeProvider>,
  );
}

function downloadingJob(overrides: Partial<TransferSnapshot> = {}): TransferSnapshot {
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

describe("Dashboard shell", () => {
  it("shows online address and the four status rows with storage free", async () => {
    const bridge = new MockServerBridge();
    renderDashboard(bridge);
    await screen.findByTestId("online-line");
    expect(screen.getByTestId("online-line").textContent).toContain("26.14.203.87:47821");
    expect(screen.getByTestId("status-radmin").textContent).toContain("Connected");
    expect(screen.getByTestId("status-qbittorrent").textContent).toContain("5.2.1");
    expect(screen.getByTestId("status-viking").textContent).toContain("Ready");
    expect(screen.getByTestId("storage-card").textContent).toMatch(/1\.4 TB/);
  });

  it("surfaces the Radmin offline banner when health reports disconnection", async () => {
    const bridge = new MockServerBridge();
    renderDashboard(bridge);
    await screen.findByTestId("status-card");
    bridge.emitHealth({ radmin: { state: "error", detail: "Disconnected" }, online: false });
    const banner = await screen.findByTestId("offline-banner");
    expect(banner.textContent).toContain("Radmin · Disconnected.");
    expect(banner.textContent).toContain(
      "Server is unavailable to Client until Radmin reconnects.",
    );
  });
});

describe("Pairing", () => {
  it("displays a formatted code, expiry countdown, and regenerates", async () => {
    const bridge = new MockServerBridge();
    renderDashboard(bridge);
    await screen.findByTestId("status-card");
    fireEvent.click(screen.getByTestId("pair-client"));
    const code = await screen.findByTestId("pairing-code");
    expect(code.textContent).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(screen.getByTestId("pairing-countdown").textContent).toContain("10:00");
    expect(screen.getByText("Enter this code on the Client PC.")).toBeTruthy();
    // No bearer tokens in the pairing surface.
    expect(document.body.textContent).not.toMatch(/bearer/i);
    const firstCode = code.textContent;
    fireEvent.click(screen.getByTestId("pairing-regenerate"));
    await waitFor(() =>
      expect(screen.getByTestId("pairing-code").textContent).not.toBe(firstCode),
    );
  });

  it("marks the countdown urgent under a minute without fake timers", async () => {
    const bridge = new MockServerBridge({ pairingTtlSeconds: 45 });
    renderDashboard(bridge);
    await screen.findByTestId("status-card");
    fireEvent.click(screen.getByTestId("pair-client"));
    const countdown = await screen.findByTestId("pairing-countdown");
    expect(countdown.textContent).toMatch(/00:4[0-5]/);
    expect(countdown.querySelector(".text-red-600")).not.toBeNull();
  });
});

describe("Active transfer", () => {
  it("mirrors download progress, speed, seeds/peers and free storage", async () => {
    const bridge = new MockServerBridge({ job: downloadingJob() });
    renderDashboard(bridge);
    const card = await screen.findByTestId("active-transfer");
    expect(card.textContent).toContain("The Show Complete");
    expect(card.textContent).toContain("74%");
    expect(card.textContent).toMatch(/38\.7 MB\/s/);
    expect(card.textContent).toContain("Seeds 7 · Peers 18");
    expect(card.textContent).toMatch(/221 GB/);
  });

  it("advances stage chips to packaging once download completes", async () => {
    const bridge = new MockServerBridge({ job: downloadingJob() });
    renderDashboard(bridge);
    await screen.findByTestId("active-transfer");
    bridge.emitJob(downloadingJob({ state: "packaging", telemetry: null }));
    await waitFor(() =>
      expect(screen.getByLabelText("Transfer stages").textContent).toContain("Packaging"),
    );
    const chips = screen.getByLabelText("Transfer stages").textContent ?? "";
    expect(chips).toContain("✓ Download");
  });
});

describe("Storage warnings", () => {
  it("strongly surfaces low space during a job", async () => {
    const job = downloadingJob();
    job.storage = { ...job.storage!, warning: "critical" };
    const bridge = new MockServerBridge({ job });
    renderDashboard(bridge);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("critically low");
  });

  it("lists remaining torrent + ZIP reservation + projected headroom during a job", async () => {
    const bridge = new MockServerBridge({ job: downloadingJob() });
    renderDashboard(bridge);
    const card = await screen.findByTestId("storage-card");
    for (const label of ["Free", "Remaining torrent", "ZIP reservation", "Projected headroom"]) {
      expect(card.textContent).toContain(label);
    }
  });
});

describe("Interrupted job", () => {
  const interruptedHistory: HistoryEntry[] = [
    {
      id: "job-9",
      name: "Interrupted Show",
      finalState: "interrupted",
      finishedAt: "2026-08-21T10:00:00Z",
    },
  ];

  it("shows the fixed copy and only backend-provided actions", async () => {
    const bridge = new MockServerBridge({ history: interruptedHistory });
    renderDashboard(bridge);
    const banner = await screen.findByTestId("interrupted-banner");
    expect(banner.textContent).toContain(
      "Previous transfer was interrupted when Viking Relay stopped unexpectedly. Automatic resume is not supported.",
    );
    expect(screen.getByRole("button", { name: "Open qBittorrent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clean up job data" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("hides actions the backend does not provide (no fake recovery)", async () => {
    const bridge = new MockServerBridge({
      history: interruptedHistory,
      capabilities: {
        dismissInterruptedJob: false,
        cleanJobData: false,
        openQBittorrentWebUi: false,
      },
    });
    renderDashboard(bridge);
    await screen.findByTestId("interrupted-banner");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clean up job data" })).toBeNull();
  });

  it("dismiss removes the banner via history refresh", async () => {
    const bridge = new MockServerBridge({ history: interruptedHistory });
    renderDashboard(bridge);
    await screen.findByTestId("interrupted-banner");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByTestId("interrupted-banner")).toBeNull());
  });
});

describe("Settings secrets handling", () => {
  it("never echoes the API key back after save", async () => {
    const bridge = new MockServerBridge();
    renderDashboard(bridge);
    await screen.findByTestId("status-card");
    fireEvent.click(screen.getByTestId("open-settings"));
    const keyInput = (await screen.findByTestId("settings-qbit-key")) as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "plain-visible-key" } });
    fireEvent.click(screen.getByTestId("save-qbit-key"));
    await screen.findByTestId("qbit-key-saved-indicator");
    await waitFor(() => expect((screen.getByTestId("settings-qbit-key") as HTMLInputElement).value).toBe(""));
    expect(document.body.textContent).not.toContain("plain-visible-key");
    const settings = await bridge.getSettings();
    expect(settings.qbitApiKeySet).toBe(true);
    assertNoPlaintextSecrets(settings as unknown as Record<string, unknown>, [
      "qbitApiKey",
      "vikingUserHash",
    ]);
  });
});

describe("Exit confirmation", () => {
  it("requires deliberate confirmation while a transfer is active", async () => {
    const bridge = new MockServerBridge({ job: downloadingJob() });
    let exitRequested = 0;
    bridge.requestAppExit = async () => {
      exitRequested += 1;
    };
    renderDashboard(bridge);
    await screen.findByTestId("active-transfer");
    fireEvent.click(screen.getByTestId("exit-button"));
    expect(await screen.findByTestId("exit-active-warning")).toBeTruthy();
    fireEvent.click(screen.getByTestId("exit-cancel"));
    expect(exitRequested).toBe(0);
    fireEvent.click(screen.getByTestId("exit-button"));
    fireEvent.click(await screen.findByTestId("exit-confirm"));
    expect(exitRequested).toBe(1);
  });
});
