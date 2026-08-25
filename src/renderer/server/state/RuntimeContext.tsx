/**
 * Runtime state for Server Mode: subscribes to bridge events and exposes
 * snapshots + actions. Single subscription point — screens stay declarative.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AppSettings,
  HealthSnapshot,
  HistoryEntry,
  PairingInfo,
  ServerCapabilities,
  SettingsPatch,
  TransferSnapshot,
  VikingRelayServerBridge,
} from "../bridge/types";

export interface RuntimeValue {
  loaded: boolean;
  settings: AppSettings | null;
  health: HealthSnapshot | null;
  job: TransferSnapshot | null;
  history: HistoryEntry[];
  pairing: PairingInfo | null;
  capabilities: ServerCapabilities | null;
  generatePairing: () => Promise<void>;
  clearPairing: () => void;
  saveSettings: (patch: SettingsPatch) => Promise<void>;
  refreshSettings: () => Promise<void>;
  refreshHistory: () => Promise<void>;
}

const RuntimeContext = createContext<RuntimeValue | null>(null);

/** Job states that finalize the persisted history record. */
const TERMINAL_JOB_STATES = new Set(["complete", "failed", "cancelled", "interrupted"]);

export function useRuntime(): RuntimeValue {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("useRuntime must be used inside <RuntimeProvider>");
  return value;
}

export function RuntimeProvider({
  bridge,
  children,
}: {
  bridge: VikingRelayServerBridge;
  children: React.ReactNode;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [job, setJob] = useState<TransferSnapshot | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [loaded, setLoaded] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const offHealth = bridge.onHealth(setHealth);
    const offJob = bridge.onJob(setJob);
    const offPairing = bridge.onPairing(setPairing);

    void (async () => {
      const [initialSettings, initialHealth, initialJob, caps] = await Promise.all([
        bridge.getSettings(),
        bridge.getHealth(),
        bridge.getActiveJob(),
        bridge.capabilities(),
      ]);
      if (!mountedRef.current) return;
      setSettings(initialSettings);
      setHealth(initialHealth);
      setJob(initialJob);
      setCapabilities(caps);
      setHistory(await bridge.getHistory(20));
      setLoaded(true);
    })();

    return () => {
      mountedRef.current = false;
      offHealth();
      offJob();
      offPairing();
    };
  }, [bridge]);

  const generatePairing = useCallback(async () => {
    const next = await bridge.generatePairingCode();
    if (mountedRef.current) setPairing(next);
  }, [bridge]);

  const clearPairing = useCallback(() => setPairing(null), []);

  const saveSettings = useCallback(
    async (patch: SettingsPatch) => {
      const next = await bridge.updateSettings(patch);
      if (mountedRef.current) setSettings(next);
    },
    [bridge],
  );

  // Re-reads settings from main. Required after flows that mutate settings
  // OUTSIDE saveSettings (e.g. the setup wizard's setWorkingFolderPath /
  // setQbitApiKey): without it the Gate keeps rendering the wizard even
  // after setup completed and the server started.
  const refreshSettings = useCallback(async () => {
    const next = await bridge.getSettings();
    if (mountedRef.current) setSettings(next);
  }, [bridge]);

  const refreshHistory = useCallback(async () => {
    setHistory(await bridge.getHistory(20));
  }, [bridge]);

  // A pushed terminal job snapshot means the persisted history just changed —
  // re-read it so "Recent transfers" reflects completions without a restart.
  useEffect(() => {
    if (job && TERMINAL_JOB_STATES.has(job.state)) void refreshHistory();
  }, [job, refreshHistory]);

  const value = useMemo<RuntimeValue>(
    () => ({
      loaded,
      settings,
      health,
      job,
      history,
      pairing,
      capabilities,
      generatePairing,
      clearPairing,
      saveSettings,
      refreshSettings,
      refreshHistory,
    }),
    [
      loaded,
      settings,
      health,
      job,
      history,
      pairing,
      capabilities,
      generatePairing,
      clearPairing,
      saveSettings,
      refreshSettings,
      refreshHistory,
    ],
  );

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}
