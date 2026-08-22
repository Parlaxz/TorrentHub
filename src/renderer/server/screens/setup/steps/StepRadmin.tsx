/** Setup step 2 — Radmin VPN detection, retry, and safe interface choice. */

import { useEffect, useState } from "react";
import { Button } from "../../../components/ui";
import type { RadminInterfaceInfo } from "../../../bridge/types";
import type { StepProps } from "../SetupWizard";

export const RADMIN_NOT_DETECTED = "Radmin VPN wasn't detected or is disconnected.";

export function StepRadmin({ bridge, state, dispatch }: StepProps) {
  const [relayPort, setRelayPort] = useState<number | null>(null);

  useEffect(() => {
    void bridge.getSettings().then((settings) => setRelayPort(settings.relayPort));
  }, [bridge]);

  const refresh = async () => {
    dispatch({ type: "RADMIN_BUSY", busy: true });
    try {
      dispatch({ type: "RADMIN_STATUS", status: await bridge.getRadminStatus() });
    } catch {
      dispatch({ type: "RADMIN_BUSY", busy: false });
    }
  };

  const pickInterface = async (id: string) => {
    dispatch({ type: "RADMIN_BUSY", busy: true });
    try {
      dispatch({ type: "RADMIN_STATUS", status: await bridge.selectRadminInterface(id) });
    } catch {
      dispatch({ type: "RADMIN_BUSY", busy: false });
    }
  };

  const radmin = state.radmin;
  const candidates: RadminInterfaceInfo[] = radmin?.candidates ?? [];
  const serverAddress =
    radmin?.connected && radmin.ipv4 && relayPort ? `${radmin.ipv4}:${relayPort}` : null;

  return (
    <div className="space-y-4">
      {radmin === null ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Checking for Radmin VPN…</p>
      ) : radmin.detected && radmin.connected ? (
        <>
          <ul className="space-y-1.5 text-sm text-zinc-700 dark:text-zinc-300">
            <li className="flex items-center gap-2">
              <span aria-hidden="true" className="text-emerald-600 dark:text-emerald-400">✓</span>
              Adapter found{radmin.adapterName ? ` — ${radmin.adapterName}` : ""}
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden="true" className="text-emerald-600 dark:text-emerald-400">✓</span>
              IPv4 address<span className="font-mono">{radmin.ipv4}</span>
            </li>
          </ul>
          {serverAddress ? (
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-xs uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Server address
              </p>
              <p className="mt-0.5 font-mono text-lg font-semibold text-zinc-900 dark:text-zinc-100" data-testid="server-address">
                {serverAddress}
              </p>
            </div>
          ) : null}
        </>
      ) : radmin.ambiguous && candidates.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm text-zinc-600 dark:text-zinc-300">
            Several network interfaces are available. Pick the Radmin VPN one:
          </legend>
          {candidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => void pickInterface(candidate.id)}
              disabled={state.radminBusy}
              data-testid={`radmin-candidate-${candidate.id}`}
              className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                radmin.selectedId === candidate.id
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
                  : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              }`}
            >
              <span className="font-medium text-zinc-800 dark:text-zinc-200">{candidate.name}</span>
              <span className="font-mono text-zinc-500 dark:text-zinc-400">{candidate.ipv4}</span>
            </button>
          ))}
        </fieldset>
      ) : (
        <>
          <p role="alert" className="text-sm text-red-600 dark:text-red-400" data-testid="radmin-missing">
            {RADMIN_NOT_DETECTED}
          </p>
          <Button onClick={() => void refresh()} disabled={state.radminBusy}>
            Retry
          </Button>
        </>
      )}
    </div>
  );
}
