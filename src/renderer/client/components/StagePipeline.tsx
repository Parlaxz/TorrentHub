import type { ReactNode } from "react";
import type { StageState } from "../types";
import { Badge } from "./ui";

export interface DisplayStage {
  key: "download" | "package" | "upload";
  title: string;
  state: StageState;
  /** Rendered inside the stage when active (progress block) or failed (message). */
  detail?: ReactNode;
  /** Secondary line, e.g. "Skipped — uploading file directly". */
  note?: string;
}

function StateIcon({ state }: { state: StageState }) {
  if (state === "complete") {
    return (
      <span
        aria-hidden="true"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[11px] font-bold text-white"
      >
        ✓
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span
        aria-hidden="true"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-600 text-[11px] font-bold text-white"
      >
        ✕
      </span>
    );
  }
  if (state === "skipped") {
    return (
      <span
        aria-hidden="true"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-dashed border-zinc-400 text-[11px] font-bold text-zinc-400 dark:border-zinc-600 dark:text-zinc-500"
      >
        –
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`h-5 w-5 shrink-0 rounded-full border-2 ${
        state === "active"
          ? "border-blue-600 border-t-transparent animate-spin"
          : "border-zinc-300 dark:border-zinc-700"
      }`}
    />
  );
}

/**
 * Vertical DOWNLOAD → PACKAGE → UPLOAD TO VIKING pipeline.
 * No fake overall percentage anywhere; each stage owns its own state.
 */
export function StagePipeline({ stages }: { stages: DisplayStage[] }) {
  return (
    <ol className="flex flex-col gap-1" aria-label="Job stages">
      {stages.map((s) => (
        <li
          key={s.key}
          aria-current={s.state === "active" ? "step" : undefined}
          className={`rounded-md px-3 py-2.5 ${
            s.state === "active" ? "bg-blue-50 dark:bg-blue-950/40" : ""
          }`}
        >
          <div className="flex items-center gap-2.5">
            <StateIcon state={s.state} />
            <span
              className={`text-sm font-semibold tracking-wide ${
                s.state === "waiting"
                  ? "text-zinc-400 dark:text-zinc-600"
                  : s.state === "failed"
                    ? "text-red-700 dark:text-red-400"
                    : "text-zinc-900 dark:text-zinc-100"
              }`}
            >
              {s.title}
            </span>
            {s.state === "skipped" && <Badge tone="neutral">Skipped</Badge>}
            {s.state === "failed" && <Badge tone="red">Failed</Badge>}
            {s.note && s.state === "skipped" ? (
              <span className="text-xs text-zinc-500 dark:text-zinc-500">{s.note}</span>
            ) : null}
          </div>
          {s.detail ? <div className="mt-2 pl-[30px]">{s.detail}</div> : null}
        </li>
      ))}
    </ol>
  );
}
