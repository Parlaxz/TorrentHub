import { Badge, Button, EmptyState, Panel } from "../components/ui";
import type { VikingBridge } from "../lib/bridge";
import { formatBytes } from "../lib/format";
import type { HistoryEntry } from "../types";

function statusBadge(state: HistoryEntry["state"]) {
  switch (state) {
    case "complete":
      return <Badge tone="green">Complete</Badge>;
    case "failed":
      return <Badge tone="red">Failed</Badge>;
    case "interrupted":
      return <Badge tone="amber">Interrupted</Badge>;
    case "cancelled":
      return <Badge tone="neutral">Cancelled</Badge>;
    default:
      return <Badge tone="blue">{state.replace(/_/g, " ")}</Badge>;
  }
}

/** Screen 10 — minimal recent-jobs list. */
export function HistoryScreen({
  bridge,
  entries,
  onClose,
}: {
  bridge: VikingBridge;
  entries: HistoryEntry[] | null;
  onClose: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-xl px-6 py-6">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-base font-bold text-zinc-900 dark:text-zinc-100">Recent jobs</h1>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      <Panel className="p-0">
        {entries == null ? (
          <EmptyState title="Loading…" />
        ) : entries.length === 0 ? (
          <EmptyState title="No jobs yet" detail="Submitted torrents will appear here." />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {statusBadge(e.state)}
                    <span className="truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-200" title={e.name}>
                      {e.name}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-500">
                    {e.sizeBytes != null ? <span>{formatBytes(e.sizeBytes)}</span> : null}
                    {e.completedAt ? (
                      <span>{new Date(e.completedAt).toLocaleString()}</span>
                    ) : null}
                  </div>
                </div>
                {e.url ? (
                  <Button
                    variant="ghost"
                    className="shrink-0 px-2 py-1 text-xs"
                    onClick={() => void bridge.copyText(e.url!)}
                  >
                    Copy
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
