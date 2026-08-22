import { useMemo, useState } from "react";
import { FileTree } from "../components/FileTree";
import { StorageTable, type StorageRow } from "../components/StorageTable";
import { Badge, Button, ErrorText, Panel, SectionTitle, Spinner } from "../components/ui";
import type { VikingBridge } from "../lib/bridge";
import { formatBytes, formatCount } from "../lib/format";
import { startBlocked, storageVerdict, zipNotice } from "../lib/preflight";
import type { IntakeDraftView, StoragePreflight } from "../types";

/**
 * Screen 4 — file selection + storage preflight.
 * Canonical selection = qBittorrent FILE INDEXES (sorted, unique).
 * All disk figures are rendered verbatim from the server's preflight.
 */
export function SelectionScreen({
  bridge,
  draft,
  onStarted,
  onBack,
}: {
  bridge: VikingBridge;
  draft: IntakeDraftView;
  onStarted: () => void;
  onBack: () => void;
}) {
  const meta = draft.metadata!;
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(meta.files.map((f) => f.index)),
  );
  const [preflight, setPreflight] = useState<StoragePreflight | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Any selection change invalidates the previous server verdict.
  const handleSelectionChange = (next: Set<number>): void => {
    setSelected(next);
    setPreflight(null);
    setError(null);
  };

  const stats = useMemo(() => {
    let bytes = 0;
    for (const f of meta.files) if (selected.has(f.index)) bytes += f.sizeBytes;
    return { count: selected.size, bytes };
  }, [meta.files, selected]);

  const notice = zipNotice(selected.size, meta.name, {
    selectedBytes: stats.bytes,
    tempZipBytes: preflight?.tempZipBytes,
  });
  const blocked = startBlocked(preflight);
  const verdict = preflight ? storageVerdict(preflight) : null;

  const continueToPreflight = async (): Promise<void> => {
    if (selected.size === 0) {
      setError("Select at least one file.");
      return;
    }
    setError(null);
    setConfirming(true);
    try {
      const indexes = [...selected].sort((a, b) => a - b);
      const res = await bridge.confirmSelection(draft.id, indexes);
      if (res.ok) {
        setPreflight(res.value);
      } else {
        setError(res.error || "The server rejected this selection.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      setConfirming(false);
    }
  };

  const start = async (): Promise<void> => {
    if (!preflight || blocked) return;
    setError(null);
    try {
      await bridge.startJob(draft.id);
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the job.");
    }
  };

  const rows: StorageRow[] | null = preflight
    ? [
        { label: "Selected files", bytes: preflight.selectedBytes },
        ...(preflight.tempZipBytes != null
          ? [{ label: "Temporary ZIP", bytes: preflight.tempZipBytes }]
          : []),
        { label: "Safety reserve", bytes: preflight.safetyReserveBytes },
        { label: "Peak required", bytes: preflight.peakRequiredBytes, strong: true },
        { label: "Server free", bytes: preflight.serverFreeBytes },
      ]
    : null;

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
        <FileTree files={meta.files} selected={selected} onSelectionChange={handleSelectionChange} />
      </Panel>

      {/* ZIP requirement */}
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
            <span className="font-mono font-semibold">{notice.zipName}</span>
          </p>
          <p className="mt-0.5 text-[13px] leading-snug opacity-90">
            The ZIP uses no recompression, but temporarily requires approximately{" "}
            {formatBytes(notice.tempZipBytes)} on the server.
          </p>
        </div>
      ) : (
        <div
          role="status"
          className="mb-4 flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
        >
          <span aria-hidden="true">↥</span>
          Upload selected file directly — no packaging needed.
        </div>
      )}

      {/* Server-authoritative preflight */}
      {preflight && rows ? (
        <Panel className="mb-4">
          <SectionTitle right={verdict ? <Badge tone={verdict.ok ? "green" : "red"}>{verdict.ok ? "✓ Enough storage" : "⚠ Blocked"}</Badge> : undefined}>
            Storage check
          </SectionTitle>
          <StorageTable rows={rows} />
          {!verdict?.ok ? (
            <p role="alert" className="mt-2 text-sm font-semibold text-red-700 dark:text-red-400">
              ⚠ {verdict?.text}
            </p>
          ) : null}
        </Panel>
      ) : null}

      <ErrorText>{error}</ErrorText>

      <div className="mt-4 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          ← Back
        </Button>
        {preflight ? (
          <Button onClick={() => void start()} disabled={blocked || confirming} className="min-w-28">
            {blocked ? "Storage blocked" : "Start"}
          </Button>
        ) : (
          <Button onClick={() => void continueToPreflight()} disabled={confirming || selected.size === 0} className="min-w-28">
            {confirming ? <Spinner /> : null}
            Continue
          </Button>
        )}
      </div>
    </div>
  );
}
