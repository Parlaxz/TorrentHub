/** Concise "what is this machine doing" card for the active job. */

import type { TransferSnapshot } from "../bridge/types";
import { PHASE_LABELS, stageChips, transferSummary } from "../domain/derive";
import { Card, CardTitle, ProgressBar, StatusDot } from "../components/ui";

const CHIP_TONES = {
  waiting: "border-zinc-200 text-zinc-400 dark:border-zinc-800 dark:text-zinc-600",
  active: "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  complete: "border-emerald-500 text-emerald-700 dark:text-emerald-400",
  failed: "border-red-500 text-red-700 dark:text-red-400",
} as const;

export function ActiveTransferCard({ job }: { job: TransferSnapshot }) {
  const summary = transferSummary(job);
  const chips = stageChips(job);
  const alertTone = summary.warning !== "none";

  return (
    <Card data-testid="active-transfer">
      <CardTitle>Active transfer</CardTitle>
      <div aria-live="polite">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-50">
            {summary.name}
          </h3>
          <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {summary.phaseLabel}
          </span>
        </div>

        {summary.phase === "download" ? (
          <>
            <div className="mt-2 flex items-center gap-3">
              <ProgressBar value={summary.percent} label={`${summary.name} download progress`} tone={alertTone ? "alert" : "normal"} />
              <span className="w-12 shrink-0 text-right font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {Math.round(summary.percent)}%
              </span>
            </div>
            <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">
              <span className="font-mono">{summary.speedText}</span>
              {" · Seeds "}
              {summary.seeds}
              {" · Peers "}
              {summary.peers}
              {summary.etaText !== "—" ? ` · ${summary.etaText}` : ""}
            </p>
          </>
        ) : null}

        {(summary.phase === "packaging" || summary.phase === "upload" || summary.phase === "finalizing") && job.zipRequired ? (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            {PHASE_LABELS[summary.phase]} — download finished, preparing the archive for Viking.
          </p>
        ) : null}
        {summary.phase === "upload" && !job.zipRequired ? (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Uploading to Viking…</p>
        ) : null}

        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Transfer stages">
          {chips.map((chip) => (
            <li
              key={chip.phase}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${CHIP_TONES[chip.status]}`}
              aria-current={chip.status === "active" ? "step" : undefined}
            >
              {chip.status === "complete" ? "✓ " : chip.status === "failed" ? "✕ " : ""}
              {chip.label}
            </li>
          ))}
        </ul>

        <p className="mt-3 flex items-center gap-2 border-t border-zinc-100 pt-2.5 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          <StatusDot state={alertTone ? "warn" : "ok"} />
          Storage free <span className="font-mono font-medium">{summary.freeBytesText}</span>
        </p>
      </div>
    </Card>
  );
}
