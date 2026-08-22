/** Setup step 3 — qBittorrent Web API connection with specific error copy. */

import { Button, TextField } from "../../../components/ui";
import { qbitErrorText } from "../../../domain/qbitErrors";
import type { StepProps } from "../SetupWizard";

export function StepQbit({ bridge, state, dispatch }: StepProps) {
  const probe = state.qbitProbe;

  const saveKeyAndTest = async () => {
    dispatch({ type: "QBIT_PROBE_START" });
    try {
      if (state.qbitKeyInput.length > 0) {
        await bridge.setQbitApiKey(state.qbitKeyInput);
        dispatch({ type: "QBIT_KEY_SAVED" });
      }
      const result = await bridge.probeQbittorrent({ webUiUrl: state.qbitUrl });
      dispatch({ type: "QBIT_PROBE_RESULT", result });
    } catch {
      dispatch({
        type: "QBIT_PROBE_RESULT",
        result: { ok: false, reason: "unknown", message: "Could not run the test." },
      });
    }
  };

  return (
    <div className="space-y-4">
      <TextField
        id="setup-qbit-url"
        label="Web API"
        value={state.qbitUrl}
        onChange={(event) => dispatch({ type: "QBIT_URL", url: event.target.value })}
        placeholder="http://127.0.0.1:8080"
        hint="qBittorrent 5.2 or newer with the Web API enabled."
      />
      <TextField
        id="setup-qbit-key"
        label="API Key"
        type="password"
        autoComplete="off"
        value={state.qbitKeyInput}
        onChange={(event) => dispatch({ type: "QBIT_KEY_INPUT", value: event.target.value })}
        placeholder={state.qbitKeySaved ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : ""}
        hint={
          state.qbitKeySaved
            ? "API key saved securely on this machine."
            : "Stored by Viking Relay — never in browser storage."
        }
        data-testid="qbit-api-key"
      />

      <Button variant="primary" onClick={() => void saveKeyAndTest()} disabled={state.qbitBusy}>
        Test
      </Button>

      {probe ? (
        probe.ok ? (
          <ul className="space-y-1.5 text-sm text-zinc-700 dark:text-zinc-300" data-testid="qbit-probe-ok">
            <li className="flex items-center gap-2">
              <span aria-hidden="true" className="text-emerald-600 dark:text-emerald-400">✓</span>
              qBittorrent connected
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden="true" className="text-emerald-600 dark:text-emerald-400">✓</span>
              Supported version{probe.version ? ` — ${probe.version}` : ""}
            </li>
          </ul>
        ) : (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400" data-testid="qbit-probe-error">
            {qbitErrorText(probe)}
          </p>
        )
      ) : null}
    </div>
  );
}
