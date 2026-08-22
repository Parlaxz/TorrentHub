/** Always-visible storage panel; expands during a job and screams when low. */

import type { StorageView } from "../bridge/types";
import { formatBytes } from "../domain/format";
import { lowSpaceMessage, storageRows } from "../domain/derive";
import { Banner, Card, CardTitle } from "../components/ui";

export function StorageCard({
  freeBytes,
  jobStorage,
}: {
  freeBytes: number | null;
  jobStorage?: StorageView | null;
}) {
  const effective: StorageView =
    jobStorage ?? {
      freeBytes,
      remainingDownloadBytes: null,
      zipReservationBytes: null,
      safetyReserveBytes: null,
      projectedHeadroomBytes: null,
      warning: "none",
    };
  const rows = storageRows(effective);
  const message = lowSpaceMessage(effective.warning);

  return (
    <div className="space-y-2">
      {message ? (
        <Banner tone={effective.warning === "critical" ? "error" : "warn"} data-testid="storage-warning">
          <strong className="font-semibold">
            {effective.warning === "critical" ? "Critical:" : "Low space:"}
          </strong>{" "}
          {message}
        </Banner>
      ) : null}
      <Card data-testid="storage-card">
        <CardTitle>Storage</CardTitle>
        <dl className="space-y-1 text-sm">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center justify-between">
              <dt className="text-zinc-600 dark:text-zinc-400">{row.label}</dt>
              <dd
                className={`font-mono ${
                  row.key === "free"
                    ? "font-semibold text-zinc-900 dark:text-zinc-100"
                    : "text-zinc-700 dark:text-zinc-300"
                }`}
              >
                {formatBytes(row.bytes)}
              </dd>
            </div>
          ))}
          {rows.length === 0 ? (
            <div className="flex items-center justify-between">
              <dt className="text-zinc-600 dark:text-zinc-400">Free</dt>
              <dd className="font-mono font-semibold text-zinc-900 dark:text-zinc-100">
                {formatBytes(freeBytes)}
              </dd>
            </div>
          ) : null}
        </dl>
      </Card>
    </div>
  );
}
