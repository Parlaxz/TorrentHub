import { useEffect, useMemo, useState } from "react";
import { FileTree } from "../components/FileTree";
import { SendToFriendModal } from "../components/SendToFriendModal";
import { StorageCheck } from "../components/StorageCheck";
import { Button, ErrorText, Modal, Panel, SectionTitle, Spinner } from "../components/ui";
import type { VikingBridge } from "../lib/bridge";
import { formatBytes, formatCount } from "../lib/format";
import { startBlocked, zipNotice } from "../lib/preflight";
import type { IntakeDraftView, StoragePreflight } from "../types";

type Action = "order" | "friend";

/**
 * Screen 4 — file selection + three exits:
 * send the link to a friend, park the download, or make an order.
 */
export function SelectionScreen({
  bridge,
  draft,
  onDone,
  onBack,
}: {
  bridge: VikingBridge;
  draft: IntakeDraftView;
  onDone: () => void;
  onBack: () => void;
}) {
  const meta = draft.metadata!;
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(meta.files.map((f) => f.index)),
  );
  const [action, setAction] = useState<Action | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const stats = useMemo(() => {
    let bytes = 0;
    for (const f of meta.files) if (selected.has(f.index)) bytes += f.sizeBytes;
    return { count: selected.size, bytes };
  }, [meta.files, selected]);

  const selectedIndexes = useMemo(
    () => [...selected].sort((a, b) => a - b),
    [selected],
  );

  const notice = zipNotice(selected.size, meta.name, { selectedBytes: stats.bytes });

  const finishSend = async (): Promise<void> => {
    // The intake draft is no longer needed; the friend job is separate.
    await bridge.cancelJob(draft.id).catch(() => {});
    onDone();
  };

  const addToDownloads = async (): Promise<void> => {
    setDownloadBusy(true);
    setActionError(null);
    try {
      await bridge.startJob(draft.id, { selection: selectedIndexes, goal: "download" });
      onDone();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not start the download.");
    } finally {
      setDownloadBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-6">
      <div className="mb-4">
        <h1 className="truncate text-base font-bold text-zinc-900 dark:text-zinc-100" title={meta.name}>
          {meta.name}
        </h1>
        <p className="mt-0.5 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
          {formatCount(meta.files.length)} files · {formatBytes(meta.totalSizeBytes)} total
          {meta.infoHashV1 ? ` · ${meta.infoHashV1.slice(0, 12)}…` : ""}
        </p>
      </div>

      <Panel className="mb-4">
        <FileTree files={meta.files} selected={selected} onSelectionChange={setSelected} />
      </Panel>

      {notice ? (
        <div
          role="status"
          className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p className="flex items-center gap-2 font-bold">
            <span aria-hidden="true">⚠</span> ZIP REQUIRED
          </p>
          <p className="mt-1 leading-snug">
            You selected {formatCount(notice.fileCount)} files. Viking Relay will package them into{" "}
            <span className="font-mono font-semibold">{notice.zipName}</span> for an order.
          </p>
          <p className="mt-0.5 text-[13px] leading-snug opacity-90">
            Add to Downloads stores the files as-is. Add to Order uses about {formatBytes(notice.tempZipBytes)}{" "}
            temporarily on the server.
          </p>
        </div>
      ) : (
        <div
          role="status"
          className="mb-4 flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
        >
          <span aria-hidden="true">↥</span>
          A single file is uploaded directly — no packaging needed.
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>
          ← Back
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => setAction("friend")}
            disabled={selected.size === 0}
            data-testid="send-to-friend-open"
          >
            Send to Friend
          </Button>
          <Button
            variant="secondary"
            onClick={() => void addToDownloads()}
            disabled={selected.size === 0 || downloadBusy}
            data-testid="add-to-downloads"
          >
            {downloadBusy ? <Spinner /> : null}
            Add to Downloads List
          </Button>
          <Button
            onClick={() => setAction("order")}
            disabled={selected.size === 0}
            data-testid="add-to-order"
          >
            Add to Order
          </Button>
        </div>
      </div>

      <ErrorText>{actionError}</ErrorText>

      <CommitModal
        open={action === "order"}
        bridge={bridge}
        draft={draft}
        indexes={selectedIndexes}
        fileCount={selected.size}
        selectedBytes={stats.bytes}
        onClose={() => setAction(null)}
        onDone={onDone}
      />

      <SendToFriendModal
        open={action === "friend"}
        onClose={() => setAction(null)}
        bridge={bridge}
        source={draft.source?.value ?? null}
        fileIndexes={selectedIndexes}
        onSent={() => void finishSend()}
      />
    </div>
  );
}

function CommitModal({
  open,
  bridge,
  draft,
  indexes,
  fileCount,
  selectedBytes,
  onClose,
  onDone,
}: {
  open: boolean;
  bridge: VikingBridge;
  draft: IntakeDraftView;
  indexes: number[];
  fileCount: number;
  selectedBytes: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [preflight, setPreflight] = useState<StoragePreflight | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState({ deleteTorrent: true, deleteFiles: true, deleteZip: true });

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPreflight(null);
    setError(null);
    setLoading(true);
    void bridge
      .preflightSelection(draft.id, indexes, "order")
      .then((res) => {
        if (!alive) return;
        if (res.ok) setPreflight(res.value);
        else setError(res.error);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, bridge, draft.id, indexes]);

  const blocked = startBlocked(preflight);
  const notice = zipNotice(fileCount, draft.metadata?.name ?? "torrent", {
    selectedBytes,
    tempZipBytes: preflight?.tempZipBytes,
  });

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await bridge.startJob(draft.id, {
        selection: indexes,
        goal: "order",
        cleanup,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the job.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add to order" wide>
      <div className="space-y-4">
        {notice ? (
          <div
            role="status"
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <p className="flex items-center gap-2 font-bold">
              <span aria-hidden="true">↥</span> ZIP REQUIRED
            </p>
            <p className="mt-1 leading-snug">
              {formatCount(notice.fileCount)} files will be packaged into{" "}
              <span className="font-mono font-semibold">{notice.zipName}</span>.
            </p>
          </div>
        ) : (
          <div
            role="status"
            className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <span aria-hidden="true">↥</span>
            Upload selected file directly — no packaging needed.
          </div>
        )}

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <Spinner /> Checking server storage…
          </p>
        ) : null}

        {preflight ? <StorageCheck preflight={preflight} /> : null}

        {preflight ? (
          <Panel>
            <SectionTitle>After upload</SectionTitle>
            <div className="space-y-1.5 text-sm text-zinc-700 dark:text-zinc-300" data-testid="cleanup-overrides">
              {(
                [
                  ["deleteTorrent", "Delete torrent from qBittorrent"],
                  ["deleteFiles", "Delete downloaded files from disk"],
                  ["deleteZip", "Delete temporary ZIP"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={cleanup[key]}
                    onChange={(e) => setCleanup((c) => ({ ...c, [key]: e.target.checked }))}
                    className="h-4 w-4"
                    data-testid={`cleanup-${key}`}
                  />
                  {label}
                </label>
              ))}
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Overrides the server's default cleanup settings for this job only.
              </p>
            </div>
          </Panel>
        ) : null}

        <ErrorText>{error}</ErrorText>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void confirm()} disabled={busy || loading || blocked || !preflight} data-testid="confirm-commit">
            {busy ? <Spinner /> : null}
            Add to Order
          </Button>
        </div>
      </div>
    </Modal>
  );
}
