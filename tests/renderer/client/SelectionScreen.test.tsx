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
    source: { kind: "magnet", value: "magnet:?xt=urn:btih:abcdef1234567890abcdef1234567890abcdef12" },
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
    preflightSelection: vi.fn(),
    startJob: vi.fn(),
    cancelJob: vi.fn(),
    friendsGet: vi.fn().mockResolvedValue([]),
    clientsList: vi.fn().mockResolvedValue([]),
  } as unknown as VikingBridge & {
    preflightSelection: Mock;
    startJob: Mock;
    cancelJob: Mock;
  };
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
  it("sends canonical qBittorrent FILE INDEXES (sorted) into an order", async () => {
    const bridge = bridgeMock();
    bridge.preflightSelection.mockResolvedValue({ ok: true, value: okPreflight });
    bridge.startJob.mockResolvedValue(undefined);
    const onDone = vi.fn();

    // Deliberately unsorted indexes in metadata.
    render(
      <SelectionScreen
        bridge={bridge}
        draft={draft([
          { index: 1, path: "b.bin", sizeBytes: 20 },
          { index: 0, path: "a.bin", sizeBytes: 10 },
        ])}
        onDone={onDone}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("add-to-order"));

    await waitFor(() =>
      expect(bridge.preflightSelection).toHaveBeenCalledWith("j9", [0, 1], "order"),
    );
    expect(await screen.findByText(/Enough storage/)).toBeTruthy();
    expect(screen.getByText("Peak required")).toBeTruthy();
    expect(screen.getByText("Temporary ZIP")).toBeTruthy();

    fireEvent.click(screen.getByTestId("confirm-commit"));
    await waitFor(() =>
      expect(bridge.startJob).toHaveBeenCalledWith("j9", {
        selection: [0, 1],
        goal: "order",
        cleanup: { deleteTorrent: true, deleteFiles: true, deleteZip: true },
      }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("starts a download directly without a confirm modal", async () => {
    const bridge = bridgeMock();
    bridge.startJob.mockResolvedValue(undefined);
    const onDone = vi.fn();

    render(
      <SelectionScreen
        bridge={bridge}
        draft={draft([
          { index: 0, path: "a.bin", sizeBytes: 10 },
          { index: 1, path: "b.bin", sizeBytes: 20 },
        ])}
        onDone={onDone}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("add-to-downloads"));

    await waitFor(() =>
      expect(bridge.startJob).toHaveBeenCalledWith("j9", { selection: [0, 1], goal: "download" }),
    );
    expect(bridge.preflightSelection).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
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
        onDone={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText("ZIP REQUIRED")).toBeTruthy();
    expect(screen.getByText(/My Torrent\.zip/)).toBeTruthy();
    expect(screen.getByText(/Add to Downloads stores the files as-is/)).toBeTruthy();
  });

  it("offers direct upload with no ZIP warning for exactly one file", () => {
    const bridge = bridgeMock();
    render(
      <SelectionScreen
        bridge={bridge}
        draft={draft([{ index: 4, path: "only.bin", sizeBytes: 5 }])}
        onDone={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/A single file is uploaded directly/)).toBeTruthy();
    expect(screen.queryByText("ZIP REQUIRED")).toBeNull();
  });

  it("disables the order when the server says storage is blocked", async () => {
    const bridge = bridgeMock();
    bridge.preflightSelection.mockResolvedValue({
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
        onDone={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("add-to-order"));

    await screen.findByText(/NOT ENOUGH SERVER STORAGE/);
    const confirm = screen.getByTestId("confirm-commit") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("surfaces a server rejection of the preflight", async () => {
    const bridge = bridgeMock();
    bridge.preflightSelection.mockResolvedValue({ ok: false, error: "selection rejected by server" });

    render(
      <SelectionScreen
        bridge={bridge}
        draft={draft([
          { index: 0, path: "a.bin", sizeBytes: 10 },
          { index: 1, path: "b.bin", sizeBytes: 20 },
        ])}
        onDone={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("add-to-order"));
    expect(await screen.findByText(/selection rejected by server/)).toBeTruthy();
  });
});
