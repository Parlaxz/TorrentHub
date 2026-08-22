/** Setup step 5 — readiness checklist + Start Server. */

import { StatusDot } from "../../../components/ui";
import { setupChecklist } from "../../../state/setupMachine";
import type { SimpleHealthState } from "../../../bridge/types";
import type { StepProps } from "../SetupWizard";

export function StepReady({ state }: StepProps) {
  const rows = setupChecklist(state);
  return (
    <div className="space-y-1">
      {rows.map((row) => {
        const rowState: SimpleHealthState = row.done ? "ok" : "error";
        return (
          <div key={row.label} className="flex items-center justify-between py-1.5 text-sm" data-testid={`ready-${row.label}`}>
            <span className="flex items-center gap-2 font-medium text-zinc-700 dark:text-zinc-300">
              <StatusDot state={rowState} />
              {row.label}
            </span>
            <span
              className={
                row.done
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400"
              }
            >
              {row.done ? "✓ Ready" : "Not ready"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
