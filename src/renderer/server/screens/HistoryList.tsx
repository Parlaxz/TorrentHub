/** Server history with copy-link, view-cause, and archive actions. */

import { useState } from "react";
import type { HistoryEntry } from "../bridge/types";
import { formatTimestamp } from "../domain/format";
import { Card, CardTitle, StatusDot } from "../components/ui";

const STATE_LABELS: Record<HistoryEntry["finalState"], string> = {
  complete: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

const STATE_TONES: Record<HistoryEntry["finalState"], "ok" | "error" | "warn" | "unknown"> = {
  complete: "ok",
  failed: "error",
  cancelled: "unknown",
  interrupted: "warn",
};

export function HistoryList({
  entries,
  archived = false,
  onCopy,
  onArchive,
}: {
  entries: HistoryEntry[];
  archived?: boolean;
  onCopy?: (text: string) => Promise<boolean>;
  onArchive?: (jobId: string, archived: boolean) => Promise<void>;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [causeId, setCauseId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (entries.length === 0) {
    return (
      <Card data-testid="history">
        <CardTitle>{archived ? "Archived transfers" : "Recent transfers"}</CardTitle>
        <p className="py-3 text-sm text-zinc-500 dark:text-zinc-400">
          {archived ? "No archived jobs." : "No finished jobs yet."}
        </p>
      </Card>
    );
  }

  const copyUrl = async (entry: HistoryEntry): Promise<void> => {
    if (!entry.url) return;
    let ok = false;
    try {
      ok = onCopy ? await onCopy(entry.url) : false;
    } catch {
      ok = false;
    }
    if (!ok) {
      try {
        await navigator.clipboard.writeText(entry.url);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopiedId(entry.id);
      window.setTimeout(() => setCopiedId(null), 2000);
    }
  };

  return (
    <Card data-testid="history">
      <CardTitle>{archived ? "Archived transfers" : "Recent transfers"}</CardTitle>
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {entries.map((entry) => {
          const hasCause =
            (entry.finalState === "failed" || entry.finalState === "interrupted") &&
            !!entry.errorMessage;
          return (
            <li key={entry.id} className="py-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate font-medium text-zinc-800 dark:text-zinc-200">
                  {entry.name}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                  <StatusDot state={STATE_TONES[entry.finalState]} />
                  {STATE_LABELS[entry.finalState]}
                </span>
                <time className="w-24 shrink-0 text-right text-xs text-zinc-500 dark:text-zinc-500">
                  {formatTimestamp(entry.finishedAt)}
                </time>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                {entry.finalState === "complete" && entry.url ? (
                  <button
                    type="button"
                    className="rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    onClick={() => void copyUrl(entry)}
                    data-testid={`copy-link-${entry.id}`}
                  >
                    {copiedId === entry.id ? "Copied ✓" : "Copy link"}
                  </button>
                ) : null}

                {hasCause ? (
                  <button
                    type="button"
                    className="rounded border border-red-300 px-2 py-0.5 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                    onClick={() => setCauseId(causeId === entry.id ? null : entry.id)}
                    data-testid={`view-cause-${entry.id}`}
                  >
                    {causeId === entry.id ? "Hide cause" : "View cause"}
                  </button>
                ) : null}

                {!archived && onArchive ? (
                  <button
                    type="button"
                    disabled={busyId === entry.id}
                    className="rounded border border-zinc-300 px-2 py-0.5 text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    onClick={() => {
                      setBusyId(entry.id);
                      void onArchive(entry.id, true).finally(() => setBusyId(null));
                    }}
                    data-testid={`archive-${entry.id}`}
                  >
                    Archive
                  </button>
                ) : null}
                {archived && onArchive ? (
                  <button
                    type="button"
                    disabled={busyId === entry.id}
                    className="rounded border border-zinc-300 px-2 py-0.5 text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    onClick={() => {
                      setBusyId(entry.id);
                      void onArchive(entry.id, false).finally(() => setBusyId(null));
                    }}
                    data-testid={`unarchive-${entry.id}`}
                  >
                    Unarchive
                  </button>
                ) : null}

                <span className="ml-auto tabular-nums text-zinc-400">{entry.id.slice(0, 8)}</span>
              </div>

              {causeId === entry.id && hasCause ? (
                <p
                  role="note"
                  className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-[12px] leading-relaxed text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
                  data-testid={`cause-${entry.id}`}
                >
                  {entry.errorMessage}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
