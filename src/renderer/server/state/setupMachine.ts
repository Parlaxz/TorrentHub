/**
 * First-run setup wizard — pure state machine.
 * No React/DOM/bridge imports; components drive it with dispatched actions.
 */

import type {
  QbitProbeResult,
  RadminStatus,
  VikingConfigView,
  VikingTestResult,
  WorkingFolderStatus,
} from "../bridge/types";

export const SETUP_STEPS = [
  "working_folder",
  "radmin",
  "qbittorrent",
  "viking",
  "ready",
] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

export const STEP_META: Record<SetupStepId, { title: string; blurb: string }> = {
  working_folder: {
    title: "Working folder",
    blurb: "Point Viking Relay at a high-capacity drive.",
  },
  radmin: { title: "Radmin VPN", blurb: "The network Client PCs use to reach this server." },
  qbittorrent: { title: "qBittorrent", blurb: "Local download engine connection." },
  viking: { title: "Viking", blurb: "Where finished transfers are uploaded." },
  ready: { title: "Ready", blurb: "Everything checks out. Start the server." },
};

export const DEFAULT_QBIT_URL = "http://127.0.0.1:8080";

export interface SetupState {
  stepIndex: number;
  /* step 1 */
  folder: WorkingFolderStatus | null;
  folderBusy: boolean;
  /* step 2 */
  radmin: RadminStatus | null;
  radminBusy: boolean;
  /* step 3 */
  qbitUrl: string;
  qbitKeyInput: string;
  qbitKeySaved: boolean;
  qbitProbe: QbitProbeResult | null;
  qbitBusy: boolean;
  /* step 4 */
  viking: VikingConfigView | null;
  vikingHashInput: string;
  vikingTest: VikingTestResult | null;
  vikingBusy: boolean;
}

export type SetupAction =
  | { type: "HYDRATE"; folder?: WorkingFolderStatus | null; qbitUrl?: string; qbitKeySaved?: boolean }
  | { type: "FOLDER_BUSY"; busy: boolean }
  | { type: "FOLDER_STATUS"; status: WorkingFolderStatus }
  | { type: "RADMIN_BUSY"; busy: boolean }
  | { type: "RADMIN_STATUS"; status: RadminStatus }
  | { type: "QBIT_URL"; url: string }
  | { type: "QBIT_KEY_INPUT"; value: string }
  | { type: "QBIT_KEY_SAVED" }
  | { type: "QBIT_PROBE_START" }
  | { type: "QBIT_PROBE_RESULT"; result: QbitProbeResult }
  | { type: "VIKING_CONFIG"; config: VikingConfigView }
  | { type: "VIKING_HASH_INPUT"; value: string }
  | { type: "VIKING_HASH_SAVED"; config: VikingConfigView }
  | { type: "VIKING_TEST_RESULT"; result: VikingTestResult | null }
  | { type: "BUSY"; key: "viking"; busy: boolean }
  | { type: "NEXT" }
  | { type: "BACK" }
  | { type: "GOTO"; index: number };

export function initialSetupState(): SetupState {
  return {
    stepIndex: 0,
    folder: null,
    folderBusy: false,
    radmin: null,
    radminBusy: false,
    qbitUrl: DEFAULT_QBIT_URL,
    qbitKeyInput: "",
    qbitKeySaved: false,
    qbitProbe: null,
    qbitBusy: false,
    viking: null,
    vikingHashInput: "",
    vikingTest: null,
    vikingBusy: false,
  };
}

/* ------------------------------ completion rules ----------------------------- */

export type StepDoneState = "complete" | "incomplete";

export function isStepComplete(state: SetupState, step: SetupStepId): StepDoneState {
  switch (step) {
    case "working_folder":
      return state.folder !== null &&
        !!state.folder.path &&
        state.folder.writable &&
        state.folder.drive !== null
        ? "complete"
        : "incomplete";
    case "radmin":
      return !!state.radmin &&
        state.radmin.detected &&
        state.radmin.connected &&
        !!state.radmin.ipv4
        ? "complete"
        : "incomplete";
    case "qbittorrent":
      return !!state.qbitProbe && state.qbitProbe.ok === true && state.qbitProbe.supported === true
        ? "complete"
        : "incomplete";
    case "viking": {
      const cfg = state.viking;
      if (!cfg) return "incomplete";
      if (cfg.mode === "anonymous") return "complete";
      if (cfg.mode === "user_hash") return "complete";
      // unconfigured: allowed only when backend permits anonymous and user picked nothing yet
      return "incomplete";
    }
    case "ready":
      return SETUP_STEPS.slice(0, 4).every((s) => isStepComplete(state, s) === "complete")
        ? "complete"
        : "incomplete";
  }
}

export interface SetupChecklistRow {
  label: string;
  done: boolean;
}

export function setupChecklist(state: SetupState): SetupChecklistRow[] {
  const labels: Record<string, string> = {
    working_folder: "Storage",
    radmin: "Radmin",
    qbittorrent: "qBittorrent",
    viking: "Viking",
  };
  return SETUP_STEPS.slice(0, 4).map((step) => ({
    label: labels[step],
    done: isStepComplete(state, step) === "complete",
  }));
}

/** True when the wizard has never been completed (show setup first). */
export function needsSetup(args: {
  settingsLoaded: boolean;
  workingFolderPath: string | null;
  healthOnline: boolean | null;
}): boolean {
  return args.settingsLoaded && args.workingFolderPath === null;
}

/* ---------------------------------- reducer ---------------------------------- */

export function setupReducer(state: SetupState, action: SetupAction): SetupState {
  switch (action.type) {
    case "HYDRATE":
      return {
        ...state,
        folder: action.folder !== undefined ? action.folder : state.folder,
        qbitUrl: action.qbitUrl ?? state.qbitUrl,
        qbitKeySaved: action.qbitKeySaved ?? state.qbitKeySaved,
      };
    case "FOLDER_BUSY":
      return { ...state, folderBusy: action.busy };
    case "FOLDER_STATUS":
      return { ...state, folder: action.status, folderBusy: false };
    case "RADMIN_BUSY":
      return { ...state, radminBusy: action.busy };
    case "RADMIN_STATUS":
      return { ...state, radmin: action.status, radminBusy: false };
    case "QBIT_URL":
      return { ...state, qbitUrl: action.url, qbitProbe: null };
    case "QBIT_KEY_INPUT":
      return { ...state, qbitKeyInput: action.value };
    case "QBIT_KEY_SAVED":
      return { ...state, qbitKeySaved: true, qbitKeyInput: "" };
    case "QBIT_PROBE_START":
      return { ...state, qbitBusy: true, qbitProbe: null };
    case "QBIT_PROBE_RESULT":
      return { ...state, qbitBusy: false, qbitProbe: action.result };
    case "VIKING_CONFIG":
      return { ...state, viking: action.config, vikingBusy: false };
    case "VIKING_HASH_INPUT":
      return { ...state, vikingHashInput: action.value };
    case "VIKING_HASH_SAVED":
      return { ...state, viking: action.config, vikingHashInput: "", vikingBusy: false, vikingTest: null };
    case "VIKING_TEST_RESULT":
      return { ...state, vikingTest: action.result, vikingBusy: false };
    case "BUSY":
      return action.key === "viking" ? { ...state, vikingBusy: action.busy } : state;
    case "NEXT":
      return {
        ...state,
        stepIndex: Math.min(SETUP_STEPS.length - 1, state.stepIndex + 1),
      };
    case "BACK":
      return { ...state, stepIndex: Math.max(0, state.stepIndex - 1) };
    case "GOTO":
      // Only allow navigating to completed earlier steps or the immediate next.
      return {
        ...state,
        stepIndex: Math.max(
          0,
          Math.min(action.index, state.stepIndex + 1, SETUP_STEPS.length - 1),
        ),
      };
    default:
      return state;
  }
}
