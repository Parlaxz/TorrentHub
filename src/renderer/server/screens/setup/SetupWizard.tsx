/**
 * First-run setup wizard shell + step registry.
 * Steps live in ./steps/*; all state flows through the pure setupMachine.
 */

import React, { useEffect, useMemo, useReducer } from "react";
import type { VikingRelayServerBridge } from "../../bridge/types";
import { Button } from "../../components/ui";
import {
  SETUP_STEPS,
  STEP_META,
  initialSetupState,
  isStepComplete,
  setupReducer,
} from "../../state/setupMachine";
import { StepFolder } from "./steps/StepFolder";
import { StepQbit } from "./steps/StepQbit";
import { StepRadmin } from "./steps/StepRadmin";
import { StepReady } from "./steps/StepReady";
import { StepViking } from "./steps/StepViking";

export interface StepProps {
  bridge: VikingRelayServerBridge;
  state: ReturnType<typeof initialSetupState>;
  dispatch: (action: Parameters<typeof setupReducer>[1]) => void;
}

const STEP_COMPONENTS: Record<string, React.ComponentType<StepProps>> = {
  working_folder: StepFolder,
  radmin: StepRadmin,
  qbittorrent: StepQbit,
  viking: StepViking,
  ready: StepReady,
};

export function SetupWizard({
  bridge,
  onComplete,
}: {
  bridge: VikingRelayServerBridge;
  onComplete: () => void;
}) {
  const [state, dispatch] = useReducer(setupReducer, undefined, initialSetupState);

  // Initial hydration: folder status + radmin + viking config in parallel.
  useEffect(() => {
    void (async () => {
      dispatch({ type: "FOLDER_BUSY", busy: true });
      dispatch({ type: "RADMIN_BUSY", busy: true });
      const [folder, radmin, viking] = await Promise.all([
        bridge.getWorkingFolderStatus().catch(() => null),
        bridge.getRadminStatus().catch(() => null),
        bridge.getVikingConfig().catch(() => null),
      ]);
      if (folder) dispatch({ type: "FOLDER_STATUS", status: folder });
      if (radmin) dispatch({ type: "RADMIN_STATUS", status: radmin });
      if (viking) dispatch({ type: "VIKING_CONFIG", config: viking });
    })();
  }, [bridge]);

  const stepId = SETUP_STEPS[state.stepIndex];
  const StepBody = STEP_COMPONENTS[stepId];
  const currentComplete = useMemo(() => isStepComplete(state, stepId), [state, stepId]);
  const isLast = state.stepIndex === SETUP_STEPS.length - 1;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col px-6 py-10">
      <header className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">
          Viking Relay
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Server setup</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Five quick checks and this machine is ready to relay.
        </p>
      </header>

      {/* stepper */}
      <ol className="mb-6 flex items-center gap-1.5" aria-label="Setup progress">
        {SETUP_STEPS.map((id, index) => {
          const done = index < state.stepIndex || (index !== state.stepIndex && isStepComplete(state, id) === "complete");
          const active = index === state.stepIndex;
          return (
            <li key={id} className="flex-1" aria-current={active ? "step" : undefined}>
              <div
                title={STEP_META[id].title}
                className={`h-1.5 rounded-full ${
                  active
                    ? "bg-blue-600"
                    : done
                      ? "bg-emerald-500"
                      : "bg-zinc-200 dark:bg-zinc-800"
                }`}
              />
              <span
                className={`mt-1.5 block text-[11px] font-medium ${
                  active ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-500 dark:text-zinc-500"
                }`}
              >
                {index + 1}. {STEP_META[id].title}
              </span>
            </li>
          );
        })}
      </ol>

      <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          {STEP_META[stepId].title}
        </h2>
        <p className="mt-0.5 mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          {STEP_META[stepId].blurb}
        </p>
        {StepBody ? <StepBody bridge={bridge} state={state} dispatch={dispatch} /> : null}
      </section>

      <footer className="mt-6 flex items-center justify-between">
        <Button onClick={() => dispatch({ type: "BACK" })} disabled={state.stepIndex === 0}>
          Back
        </Button>
        {isLast ? (
          <Button
            variant="primary"
            disabled={currentComplete === "incomplete"}
            data-testid="start-server"
            onClick={async () => {
              await bridge.startServer();
              onComplete();
            }}
          >
            Start Server
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={currentComplete === "incomplete"}
            data-testid="next-step"
            onClick={() => dispatch({ type: "NEXT" })}
          >
            Next
          </Button>
        )}
      </footer>
    </div>
  );
}
