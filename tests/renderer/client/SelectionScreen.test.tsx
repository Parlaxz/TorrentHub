// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SelectionScreen } from "../../../src/renderer/client/screens/SelectionScreen";
import type { IntakeDraftView, StoragePreflight, TorrentFileEntry } from "../../../src/renderer/client/types";
import type { VikingBridge } from "../../../src/renderer/client/lib/bridge";

const GB = 1024 ** 3;

function draft(files: TorrentFileEntry[]): IntakeDraftView {
  return {
    id: "j9",
    state: "awaiting_selection",
    metadata: {
      name: "My Torrent",
      infoHashV1: "abcdef1234567890abcdef1234567890abcdef12",
      files,
      totalSizeBytes: files.reduce((s, f) => s + f.sizeBytes, 0),
    },
    error: null,
  };
}

function bridgeMock() {
  return {
    confirmSelection: vi.fn(),
    startJob: vi.fn(),
    cancelJob: vi.fn(),
  } as unknown as VikingBridge & { confirmSelection: Mock; startJob: Mock };
}

const okPreflight: StoragePreflight = {
  selectedFiles: 2,
  selectedBytes: 30,
  tempZipBytes: 30,
  safetyReserveBytes: 5 * GB,
  peakRequiredBytes: 65 * GB,
  serverFreeBytes: 318.4 * GB,
  enough: true,
  blocked: false,
};

afterEach(cleanup);

describe("SelectionScreen", () => {
  it("submits canonical qBittorrent FILE INDEXES (sorted) and enables Start when storage is fine", async () => {
    const bridge = bridgeMock();
    bridge.confirmSelection.mockResolvedValue({ ok: true, value: okPreflight });
    bridge.startJob.mockResolvedValue(undefined);
    const onStarted = vi.fn();

    // Deliberately unsorted indexes in metadata.
    render(
      <SelectionScreen
        bridge={bridge}
        draft={draft([
          { index: 1, path: "b.bin", sizeBytes: 20 },
          { index: 0, path: "a.bin", sizeBytes: 10 },
        ])}
        onStarted={onStarted}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() =>
      expect(bridge.confirmSelection).toHaveBeenCalledWith("j9", [0, 1]),
    );

    const start = await screen.findByRole("button", { name: "Start" });
    expect((start as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Enough storage/)).toBeTruthy();
    expect(screen.getByText("Peak required")).toBeTruthy();
    expect(screen.getByText("Temporary ZIP")).toBeTruthy();

    fireEvent.click(start);
    await waitFor(() => expect(bridge.startJob).toHaveBeenCalledWith("j9"));
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
  });

  it("shows the ZIP warning for 2+ selected files", () => {
    const bridge = bridgeMock();
    render(
      <SelectionScreen
        bridge={bridge}
        draft={draft([
          { index: 0, path: "a.bin", sizeBytes: 10 },
          { index: 1, path: "b.bin", sizeBytes: 20 },
          { index: 2, path: "c.bin", sizeBytes: 30 },
        ])}
        onStarted={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText("ZIP REQUIRED")).toBeTruthy();
    expect(screen.getByText(/My Torrent\.zip/)).toBeTruthy();
    expect(screen.getByText(/no recompression/)).toBeTruthy();
  });

  it("offers direct upload with no ZIP warning for exactly one file", () => {
    const bridge = bridgeMock();
    render(
      <SelectionScreen
        bridge={bridge}
        draft={draft([{ index: 4, path: "only.bin", sizeBytes: 5 }])}
        onStarted={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/Upload selected file directly/)).toBeTruthy();
    expect(screen.queryByText("ZIP REQUIRED")).toBeNull();
  });

  it("disables Start when the server says storage is blocked", async () => {
    const bridge = bridgeMock();
    bridge.confirmSelection.mockResolvedValue({
      ok: true,
      value: {
        ...okPreflight,
        serverFreeBytes: 10 * GB,
        peakRequiredBytes: 100 * GB,
        enough: false,
        blocked: true,
        missingBytes: 90 * GB,
      },
    });

    render(
      <SelectionScreen
        bridge={bridge}
        draft={draft([
          { index: 0, path: "a.bin", sizeBytes: 10 },
          { index: 1, path: "b.bin", sizeBytes: 20 },
        ])}
        onStarted={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    const start = await screen.findByRole("button", { name: "Storage blocked" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/NOT ENOUGH SERVER STORAGE/)).toBeTruthy();
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("surfaces a server rejection of the selection", async () => {
    const bridge = bridgeMock();
    bridge.confirmSelection.mockResolvedValue({ ok: false, error: "selection rejected by server" });

    render(
      <SelectionScreen
        bridge={bridge}
        draft={draft([
          { index: 0, path: "a.bin", sizeBytes: 10 },
          { index: 1, path: "b.bin", sizeBytes: 20 },
        ])}
        onStarted={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByText(/selection rejected by server/)).toBeTruthy();
  });
});
