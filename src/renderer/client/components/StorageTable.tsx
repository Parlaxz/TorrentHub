import type { ReactNode } from "react";
import { formatBytes } from "../lib/format";

export interface StorageRow {
  label: string;
  bytes: number | null;
  /** Emphasize the row (e.g. Peak required). */
  strong?: boolean;
}

/** Key–value storage table; renders server-authoritative numbers verbatim. */
export function StorageTable({ rows, caption }: { rows: StorageRow[]; caption?: string }) {
  return (
    <div>
      {caption ? (
        <div className="mb-2 text-xs font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
          {caption}
        </div>
      ) : null}
      <dl className="text-sm">
        {rows.map((r) => (
          <div
            key={r.label}
            className={`flex items-baseline justify-between gap-4 border-b border-dotted border-zinc-200 py-1 last:border-0 dark:border-zinc-800 ${
              r.strong ? "font-semibold text-zinc-900 dark:text-zinc-100" : "text-zinc-600 dark:text-zinc-400"
            }`}
          >
            <dt className="truncate">{r.label}</dt>
            <dd className="shrink-0 tabular-nums">{formatBytes(r.bytes)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Yellow (low) / red (critical) server-reported storage warning. */
export function StorageWarning({
  level,
  children,
}: {
  level: "low" | "critical";
  children: ReactNode;
}) {
  const critical = level === "critical";
  return (
    <div
      role={critical ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
        critical
          ? "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300"
          : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      }`}
    >
      <span aria-hidden="true" className="mt-px font-bold">
        ⚠
      </span>
      <div className="min-w-0">
        <p className="font-semibold">{critical ? "Server storage critically low" : "Server storage running low"}</p>
        <div className="text-[13px] leading-snug opacity-90">{children}</div>
      </div>
    </div>
  );
}
