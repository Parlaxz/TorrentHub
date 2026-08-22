/** Minimal recent server history. */

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

export function HistoryList({ entries }: { entries: HistoryEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <Card data-testid="history">
      <CardTitle>Recent transfers</CardTitle>
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium text-zinc-800 dark:text-zinc-200">
              {entry.name}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
              <StatusDot state={STATE_TONES[entry.finalState]} />
              {STATE_LABELS[entry.finalState]}
            </span>
            {entry.finalState === "complete" && entry.url ? (
              <a
                href={entry.url}
                className="shrink-0 text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                onClick={(event) => event.preventDefault()}
              >
                Viking URL
              </a>
            ) : (
              <span className="w-[68px] shrink-0" />
            )}
            <time className="w-24 shrink-0 text-right text-xs text-zinc-500 dark:text-zinc-500">
              {formatTimestamp(entry.finishedAt)}
            </time>
          </li>
        ))}
      </ul>
    </Card>
  );
}
