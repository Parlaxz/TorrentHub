import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { JobDetail } from "../components/JobDetail";
import { ProgressBar } from "../components/ProgressBar";
import { StorageCheck } from "../components/StorageCheck";
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Modal,
  Panel,
  SectionTitle,
  Spinner,
} from "../components/ui";
import type {
  ConnectionStatus,
  SentDirectJobStatus,
  VikingBridge,
} from "../lib/bridge";
import { formatBytes, formatEta, formatPercent, formatSpeed } from "../lib/format";
import { isTerminalJobState, type JobSnapshot } from "../types";

const MAGNET_RE = /^magnet:\?xt=urn:btih:[a-z0-9]{32,}/i;
const URL_RE = /^https?:\/\/\S+$/i;

export function validateIntakeInput(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Paste a magnet link or a torrent URL.";
  if (MAGNET_RE.test(v)) return null;
  if (/^magnet:/i.test(v)) return "That magnet link is missing its info hash (xt=urn:btih:…).";
  if (URL_RE.test(v)) return null;
  return "Enter a magnet URI or an HTTP(S) URL pointing to a .torrent file.";
}

/** Screen 2 — add a link, see downloads, see orders. */
export function HomeScreen({
  bridge,
  connection,
  onSubmit,
  busy,
  error,
}: {
  bridge: VikingBridge | null;
  connection: ConnectionStatus | null;
  onSubmit: (input: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const [value, setValue] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [pasteBusy, setPasteBusy] = useState(false);

  const [jobs, setJobs] = useState<JobSnapshot[] | null>(null);
  const [sent, setSent] = useState<SentDirectJobStatus[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [orderIds, setOrderIds] = useState<string[] | null>(null);

  const state = connection?.state ?? "offline";

  const reload = useCallback(async (): Promise<void> => {
    if (!bridge) return;
    try {
      const [nextJobs, nextSent] = await Promise.all([
        bridge.listJobs(),
        bridge.directJobsSent(),
      ]);
      setJobs(nextJobs);
      setSent(nextSent);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Could not load downloads.");
    }
  }, [bridge]);

  useEffect(() => {
    if (!bridge || state !== "connected") return;
    let alive = true;
    const tick = async (): Promise<void> => {
      if (!alive) return;
      await reload();
    };
    void tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [bridge, state, reload]);

  const downloads = useMemo(
    () =>
      (jobs ?? []).filter(
        (job) =>
          job.goal === "download" &&
          !job.archived &&
          !job.orderedByJobId &&
          job.state !== "reading_metadata" &&
          job.state !== "awaiting_selection",
      ),
    [jobs],
  );

  const orders = useMemo(
    () =>
      (jobs ?? []).filter(
        (job) =>
          (job.goal ?? "order") === "order" &&
          job.selection != null &&
          !job.archived &&
          job.state !== "reading_metadata" &&
          job.state !== "awaiting_selection",
      ),
    [jobs],
  );

  const friendDownloads = useMemo(
    () =>
      (sent ?? []).filter(
        (item) =>
          // Defensive: only rows this client sent, even if an old server
          // returns a wider list.
          (!connection?.clientId || item.fromClientId === connection.clientId) &&
          (item.state === "queued" ||
            (item.state === "accepted" && (item.progress?.progressPct ?? 0) < 100)),
      ),
    [sent, connection?.clientId],
  );

  const selectedJobs = downloads.filter((job) => selected.has(job.id));
  const orderable = (job: JobSnapshot): boolean =>
    job.state === "queued" || job.state === "downloading" || job.state === "complete";
  const canOrder = selectedJobs.length > 0 && selectedJobs.every(orderable);
  const orderHasIncomplete = selectedJobs.some((job) => job.state !== "complete");

  const toggleSelected = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleExpanded = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const invalid = validateIntakeInput(value);
    if (invalid) {
      setLocalError(invalid);
      return;
    }
    setLocalError(null);
    onSubmit(value.trim());
  };

  const pasteClipboard = async (): Promise<void> => {
    if (!bridge) return;
    setPasteBusy(true);
    setLocalError(null);
    try {
      const text = (await bridge.readText()).trim();
      if (!text) {
        setLocalError("Clipboard is empty — copy a magnet link or torrent URL first.");
        return;
      }
      setValue(text);
    } finally {
      setPasteBusy(false);
    }
  };

  const deleteSelected = async (): Promise<void> => {
    if (!bridge || selectedJobs.length === 0) return;
    if (
      !window.confirm(
        `Delete ${selectedJobs.length} download${selectedJobs.length === 1 ? "" : "s"} and their files from the server?`,
      )
    ) {
      return;
    }
    setActionError(null);
    for (const job of selectedJobs) {
      try {
        await bridge.discardJob(job.id);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Could not delete that download.");
        break;
      }
    }
    setSelected(new Set());
    await reload();
  };

  const dismissOrder = async (job: JobSnapshot): Promise<void> => {
    if (!bridge) return;
    const active = !isTerminalJobState(job.state);
    if (
      !window.confirm(
        active ? "Stop this order?" : "Remove this order from the list?",
      )
    ) {
      return;
    }
    setActionError(null);
    try {
      await bridge.dismissJob(job.id);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not dismiss that order.");
    }
  };

  const dismissFriendDownload = async (id: string): Promise<void> => {
    if (!bridge) return;
    setActionError(null);
    try {
      await bridge.dismissDirectJob(id);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not dismiss that link.");
    }
  };

  const copy = async (text: string): Promise<void> => {
    if (bridge) await bridge.copyText(text).catch(() => false);
  };

  const open = async (text: string): Promise<void> => {
    await window.vikingRelay?.openExternal?.(text).catch(() => undefined);
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <Panel>
        <SectionTitle>Torrent / Magnet</SectionTitle>
        <form onSubmit={submit} noValidate>
          <div className="flex gap-2">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="magnet:?xt=urn:btih:…"
              aria-label="Torrent magnet link or URL"
              aria-invalid={Boolean(localError) || undefined}
              spellCheck={false}
              autoComplete="off"
              disabled={busy || state !== "connected"}
              className={`min-w-0 flex-1 rounded-md border bg-white px-3 py-2 font-mono text-[13px] text-zinc-900 placeholder:text-zinc-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60 disabled:opacity-60 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600 ${
                localError || error
                  ? "border-red-500 focus:ring-red-500/60"
                  : "border-zinc-300 focus:border-blue-500 dark:border-zinc-700"
              }`}
            />
            <Button
              variant="ghost"
              onClick={() => void pasteClipboard()}
              disabled={pasteBusy || state !== "connected"}
              data-testid="torrent-paste"
              title="Paste from clipboard"
            >
              Paste
            </Button>
          </div>
          <ErrorText>{localError ?? error}</ErrorText>
          <div className="mt-4 flex items-center justify-between">
            <p className="text-[11px] text-zinc-400 dark:text-zinc-600">
              Magnet URI or HTTP(S) .torrent URL
            </p>
            <Button type="submit" disabled={busy || state !== "connected"}>
              Continue
            </Button>
          </div>
        </form>
      </Panel>

      <Panel className="mt-4">
        <SectionTitle
          right={
            selectedJobs.length > 0 ? (
              <span className="text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                {selectedJobs.length} selected
              </span>
            ) : undefined
          }
        >
          Downloads
        </SectionTitle>

        {downloads.length === 0 ? (
          friendDownloads.length === 0 ? (
            <EmptyState
              title="No downloads yet"
              detail="Add a link above, or send one to a friend. Downloads parked here stay until you order or delete them."
            />
          ) : null
        ) : (
          <div className="space-y-2">
            {friendDownloads.length > 0 ? (
              <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                On the server
              </h3>
            ) : null}
            {downloads.map((job) => (
              <DownloadRow
                key={job.id}
                job={job}
                checked={selected.has(job.id)}
                onToggle={() => toggleSelected(job.id)}
                expanded={expanded.has(job.id)}
                onExpand={() => toggleExpanded(job.id)}
                bridge={bridge}
              />
            ))}
          </div>
        )}

        {friendDownloads.length > 0 ? (
          <div className={`space-y-2${downloads.length > 0 ? " mt-4" : ""}`}>
            <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
              Sent to friends
            </h3>
            {friendDownloads.map((item) => (
              <FriendDownloadRow
                key={item.id}
                item={item}
                onDismiss={() => void dismissFriendDownload(item.id)}
              />
            ))}
          </div>
        ) : null}

        {selectedJobs.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <Button variant="danger" onClick={() => void deleteSelected()} data-testid="delete-downloads">
              Delete
            </Button>
            <Button
              onClick={() => setOrderIds(selectedJobs.map((job) => job.id))}
              disabled={!canOrder}
              title={
                canOrder
                  ? undefined
                  : "Failed, cancelled, or interrupted downloads cannot be ordered."
              }
              data-testid="order-selected"
            >
              Add to Order
            </Button>
          </div>
        ) : null}

        <ErrorText>{actionError ?? listError}</ErrorText>
      </Panel>

      <Panel className="mt-4">
        <SectionTitle>Orders</SectionTitle>
        {orders.length === 0 ? (
          <EmptyState
            title="No orders yet"
            detail="Add a torrent to an order, or combine finished downloads into one."
          />
        ) : (
          <div className="space-y-2">
            {orders.map((job) => (
              <OrderRow
                key={job.id}
                job={job}
                jobs={jobs ?? []}
                expanded={expanded.has(job.id)}
                onExpand={() => toggleExpanded(job.id)}
                bridge={bridge}
                onDismiss={() => void dismissOrder(job)}
                onCopy={copy}
                onOpen={open}
              />
            ))}
          </div>
        )}
      </Panel>

      <OrderConfirmModal
        open={orderIds !== null}
        jobIds={orderIds ?? []}
        hasIncomplete={orderHasIncomplete}
        bridge={bridge}
        onClose={() => setOrderIds(null)}
        onDone={() => {
          setOrderIds(null);
          setSelected(new Set());
          void reload();
        }}
      />
    </div>
  );
}

function stateLabel(job: JobSnapshot): string {
  if (job.waitingForDownloads) return "Waiting for downloads";
  switch (job.state) {
    case "queued":
      return "Queued";
    case "downloading":
      return "Downloading";
    case "packaging":
      return "Packaging";
    case "uploading":
      return "Uploading";
    case "finalizing":
      return "Finalizing";
    case "complete":
      return job.goal === "download" ? "Downloaded — waiting for order" : "Complete";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    default:
      return job.state;
  }
}

function toneFor(job: JobSnapshot): "neutral" | "green" | "amber" | "red" | "blue" {
  if (job.waitingForDownloads) return "blue";
  if (job.state === "complete") return "green";
  if (job.state === "failed") return "red";
  if (job.state === "cancelled" || job.state === "interrupted") return "amber";
  if (job.state === "queued") return "neutral";
  return "blue";
}

function DownloadRow({
  job,
  checked,
  onToggle,
  expanded,
  onExpand,
  bridge,
}: {
  job: JobSnapshot;
  checked: boolean;
  onToggle: () => void;
  expanded: boolean;
  onExpand: () => void;
  bridge: VikingBridge | null;
}) {
  const t = job.telemetry ?? null;
  const name = job.metadata?.name ?? job.source.value;
  return (
    <div
      onClick={onToggle}
      className={`cursor-pointer rounded-md border px-2.5 py-2 transition-colors ${
        checked
          ? "border-blue-500 bg-blue-50/60 dark:border-blue-500 dark:bg-blue-950/20"
          : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
      }`}
      data-testid={`download-${job.id}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`Select ${name}`}
        className="sr-only"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-zinc-800 hover:underline dark:text-zinc-200"
          title={name}
          onClick={(e) => {
            e.stopPropagation();
            onExpand();
          }}
        >
          {name}
        </button>
        <Badge tone={toneFor(job)}>{stateLabel(job)}</Badge>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
        {job.selectedBytes != null ? <span>{formatBytes(job.selectedBytes)}</span> : null}
        {t ? (
          <>
            <span>{formatPercent(t.progressPct)}</span>
            <span>{formatSpeed(t.speedBps)}</span>
            {t.etaSeconds != null ? <span>ETA {formatEta(t.etaSeconds)}</span> : null}
            <span>Seeds {t.seeds}</span>
            <span>Peers {t.peers}</span>
          </>
        ) : null}
        {job.error ? <span className="text-red-600 dark:text-red-400">{job.error.message}</span> : null}
      </div>
      {t ? (
        <div className="mt-1.5">
          <ProgressBar pct={t.progressPct} label={`${name} download progress`} />
        </div>
      ) : null}
      {expanded ? (
        <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800" onClick={(e) => e.stopPropagation()}>
          <JobDetail
            job={job}
            onCancel={bridge ? () => void bridge.cancelJob(job.id) : undefined}
            onRetryPackaging={bridge ? () => void bridge.retryPackaging(job.id) : undefined}
            onRetryUpload={bridge ? () => void bridge.retryUpload(job.id) : undefined}
            showCancel={false}
          />
        </div>
      ) : null}
    </div>
  );
}

function FriendDownloadRow({
  item,
  onDismiss,
}: {
  item: SentDirectJobStatus;
  onDismiss: () => void;
}) {
  const pct = item.progress?.progressPct ?? null;
  return (
    <div
      className="rounded-md border border-zinc-200 px-2.5 py-2 dark:border-zinc-800"
      data-testid={`friend-download-${item.id}`}
    >
      <div className="flex items-center gap-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate font-mono text-zinc-600 dark:text-zinc-300" title={item.sourcePreview ?? undefined}>
          → {item.targetName}: {item.sourcePreview ?? "link"}
        </span>
        <Badge tone={item.state === "accepted" ? "blue" : "neutral"}>
          {item.state === "queued" ? "Waiting for friend" : "Downloading on friend's PC"}
        </Badge>
        <button
          type="button"
          aria-label={`Dismiss ${item.targetName} download`}
          title="Dismiss from this list"
          className="shrink-0 text-zinc-400 hover:text-red-500"
          onClick={onDismiss}
          data-testid={`dismiss-friend-download-${item.id}`}
        >
          ✕
        </button>
      </div>
      {pct != null ? (
        <div className="mt-1.5">
          <ProgressBar pct={pct} label={`${item.targetName} download progress`} />
        </div>
      ) : null}
      <div className="mt-1 flex gap-3 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
        {pct != null ? <span>{formatPercent(pct)}</span> : null}
        {item.progress?.dlSpeedBps != null ? <span>{formatSpeed(item.progress.dlSpeedBps)}</span> : null}
        {item.selection?.length ? <span>{item.selection.length} files selected</span> : null}
      </div>
    </div>
  );
}

function OrderRow({
  job,
  jobs,
  expanded,
  onExpand,
  bridge,
  onDismiss,
  onCopy,
  onOpen,
}: {
  job: JobSnapshot;
  jobs: JobSnapshot[];
  expanded: boolean;
  onExpand: () => void;
  bridge: VikingBridge | null;
  onDismiss: () => void;
  onCopy: (text: string) => Promise<void>;
  onOpen: (text: string) => Promise<void>;
}) {
  const name = job.metadata?.name ?? "Order";
  const bundled = (job.bundleJobIds ?? [])
    .map((id) => jobs.find((j) => j.id === id))
    .filter((j): j is JobSnapshot => Boolean(j));
  return (
    <div
      className="rounded-md border border-zinc-200 px-2.5 py-2 dark:border-zinc-800"
      data-testid={`order-${job.id}`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-zinc-800 hover:underline dark:text-zinc-200"
          title={name}
          onClick={onExpand}
        >
          {name}
        </button>
        <Badge tone={toneFor(job)}>{stateLabel(job)}</Badge>
        <Button
          variant="ghost"
          className="shrink-0 px-2 py-0.5 text-xs"
          onClick={onDismiss}
          data-testid={`dismiss-order-${job.id}`}
        >
          Dismiss
        </Button>
      </div>
      <div className="mt-1 pl-0 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
        {job.bundleJobIds?.length
          ? `${job.bundleJobIds.length} download${job.bundleJobIds.length === 1 ? "" : "s"} · `
          : ""}
        {job.selectedBytes != null ? formatBytes(job.selectedBytes) : ""}
        {job.error ? ` · ${job.error.message}` : ""}
      </div>
      {job.result?.url ? (
        <div className="mt-2 space-y-2">
          <input
            readOnly
            value={job.result.url}
            aria-label="Viking URL"
            onFocus={(e) => e.currentTarget.select()}
            className="w-full cursor-text rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 font-mono text-[11px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              className="px-2 py-0.5 text-xs"
              onClick={() => void onCopy(job.result!.url)}
            >
              Copy Link
            </Button>
            <Button
              variant="ghost"
              className="px-2 py-0.5 text-xs"
              onClick={() => void onOpen(job.result!.url)}
            >
              Open Link
            </Button>
            {job.result.directUrl ? (
              <>
                <Button
                  variant="ghost"
                  className="px-2 py-0.5 text-xs"
                  onClick={() => void onCopy(job.result!.directUrl!)}
                >
                  Copy Direct Link
                </Button>
                <Button
                  variant="ghost"
                  className="px-2 py-0.5 text-xs"
                  onClick={() => void onOpen(job.result!.directUrl!)}
                >
                  Open Direct Link
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      {expanded ? (
        <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          {job.waitingForDownloads ? (
            <p className="mb-3 text-xs text-blue-700 dark:text-blue-300">
              Waiting for {job.bundleJobIds?.length ?? 0} source download
              {(job.bundleJobIds?.length ?? 0) === 1 ? "" : "s"} to finish before packaging.
            </p>
          ) : null}
          {bundled.length > 0 ? (
            <div className="mb-3">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                Downloads in this order
              </p>
              <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-300">
                {bundled.map((source) => (
                  <li key={source.id}>
                    <div className="truncate">
                      {source.metadata?.name ?? source.source.value} · {stateLabel(source)}
                    </div>
                    {source.telemetry ? (
                      <div className="tabular-nums text-[11px] text-zinc-500 dark:text-zinc-400">
                        {formatPercent(source.telemetry.progressPct)} ·{" "}
                        {formatSpeed(source.telemetry.speedBps)}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <JobDetail
            job={job}
            onRetryPackaging={bridge ? () => void bridge.retryPackaging(job.id) : undefined}
            onRetryUpload={bridge ? () => void bridge.retryUpload(job.id) : undefined}
            showCancel={false}
          />
        </div>
      ) : null}
    </div>
  );
}

function OrderConfirmModal({
  open,
  jobIds,
  hasIncomplete,
  bridge,
  onClose,
  onDone,
}: {
  open: boolean;
  jobIds: string[];
  hasIncomplete: boolean;
  bridge: VikingBridge | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [preflight, setPreflight] = useState<Awaited<ReturnType<VikingBridge["preflightOrder"]>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState({ deleteTorrent: true, deleteFiles: true, deleteZip: true });

  useEffect(() => {
    if (!open || !bridge) return;
    let alive = true;
    setPreflight(null);
    setError(null);
    setLoading(true);
    void bridge
      .preflightOrder(jobIds)
      .then((next) => {
        if (alive) setPreflight(next);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : "Could not check storage.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, bridge, jobIds]);

  const blocked = preflight ? preflight.blocked === true : true;

  const confirm = async (): Promise<void> => {
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.createOrder(jobIds, cleanup);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the order.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add to order" wide>
      <div className="space-y-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          {hasIncomplete
            ? "The order will queue now and start packaging when every selected download finishes."
            : jobIds.length === 1
              ? "1 finished download will be ordered. One file uploads directly; several files are packaged first."
              : `${jobIds.length} finished downloads will be packaged into one ZIP and uploaded.`}{" "}
          Already-downloaded files are not downloaded again.
        </p>

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <Spinner /> Checking server storage…
          </p>
        ) : null}

        <StorageCheck preflight={preflight} />

        <Panel>
          <SectionTitle>After upload</SectionTitle>
          <div className="space-y-1.5 text-sm text-zinc-700 dark:text-zinc-300">
            {(
              [
                ["deleteTorrent", "Delete torrents from qBittorrent"],
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
                  data-testid={`order-cleanup-${key}`}
                />
                {label}
              </label>
            ))}
          </div>
        </Panel>

        <ErrorText>{error}</ErrorText>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void confirm()} disabled={busy || loading || blocked} data-testid="confirm-order">
            {busy ? <Spinner /> : null}
            Add to Order
          </Button>
        </div>
      </div>
    </Modal>
  );
}
