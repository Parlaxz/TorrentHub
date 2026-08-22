import { formatBytes, formatEta, formatPercent, formatSpeed } from "../lib/format";

export function ProgressBar({
  pct,
  tone = "blue",
  label,
  className = "",
}: {
  /** 0..100; clamped. */
  pct: number;
  tone?: "blue" | "green" | "amber";
  label?: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const tones = {
    blue: "bg-blue-600",
    green: "bg-emerald-600",
    amber: "bg-amber-500",
  } as const;
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={`h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800 ${className}`}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-500 ease-out ${tones[tone]}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/** Big legible stage block: bar + percent + bytes + speed + ETA. */
export function ProgressBlock({
  pct,
  done,
  total,
  speedBps,
  etaSeconds,
  tone = "blue",
  label,
}: {
  pct: number;
  done: number | null;
  total: number | null;
  speedBps?: number | null;
  etaSeconds?: number | null;
  tone?: "blue" | "green" | "amber";
  label: string;
}) {
  return (
    <div>
      <ProgressBar pct={pct} tone={tone} label={label} />
      <div className="mt-1.5 flex items-baseline justify-between gap-3 text-sm">
        <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{formatPercent(pct)}</span>
        {done != null && total != null ? (
          <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
            {formatBytes(done)} / {formatBytes(total)}
          </span>
        ) : null}
      </div>
      {(speedBps != null || etaSeconds != null) && (
        <div className="mt-0.5 flex items-center gap-4 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
          {speedBps != null && (
            <span aria-label="speed">↓ {formatSpeed(speedBps)}</span>
          )}
          {etaSeconds != null && <span aria-label="eta">ETA {formatEta(etaSeconds)}</span>}
        </div>
      )}
    </div>
  );
}
