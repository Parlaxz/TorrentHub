import { describe, expect, it } from "vitest";
import {
  DEFAULT_QBIT_URL,
  initialSetupState,
  isStepComplete,
  needsSetup,
  setupChecklist,
  setupReducer,
} from "../../../src/renderer/server/state/setupMachine";
import type { QbitProbeResult, RadminStatus, WorkingFolderStatus } from "../../../src/renderer/server/bridge/types";

const folderOk: WorkingFolderStatus = {
  path: "D:\\VikingRelay",
  drive: { root: "D:", label: "Data", kind: "fixed", totalBytes: 2e12, freeBytes: 1.4e12 },
  writable: true,
  error: null,
};

const radminOk: RadminStatus = {
  detected: true,
  connected: true,
  adapterName: "Radmin VPN",
  ipv4: "26.14.203.87",
  ambiguous: false,
  candidates: [],
  selectedId: null,
  problem: null,
};

const qbitOk: QbitProbeResult = { ok: true, version: "5.2.1", supported: true };

function completeThrough(step: "folder" | "radmin" | "qbit") {
  let state = initialSetupState();
  state = setupReducer(state, { type: "FOLDER_STATUS", status: folderOk });
  if (step === "folder") return state;
  state = setupReducer(state, { type: "RADMIN_STATUS", status: radminOk });
  if (step === "radmin") return state;
  state = setupReducer(state, { type: "QBIT_PROBE_RESULT", result: qbitOk });
  return state;
}

describe("isStepComplete", () => {
  it("requires a writable folder with drive stats", () => {
    const empty = initialSetupState();
    expect(isStepComplete(empty, "working_folder")).toBe("incomplete");
    const noDrive = setupReducer(empty, {
      type: "FOLDER_STATUS",
      status: { ...folderOk, drive: null },
    });
    expect(isStepComplete(noDrive, "working_folder")).toBe("incomplete");
    expect(isStepComplete(completeThrough("folder"), "working_folder")).toBe("complete");
  });

  it("requires connected radmin with an IPv4 address", () => {
    const disconnected = setupReducer(initialSetupState(), {
      type: "RADMIN_STATUS",
      status: { ...radminOk, detected: false, connected: false, ipv4: null },
    });
    expect(isStepComplete(disconnected, "radmin")).toBe("incomplete");
    expect(isStepComplete(completeThrough("folder"), "radmin")).toBe("incomplete");
  });

  it("requires a successful supported qBittorrent probe", () => {
    const base = completeThrough("radmin");
    const tooOld = setupReducer(base, {
      type: "QBIT_PROBE_RESULT",
      result: { ok: false, reason: "version_too_old" },
    });
    expect(isStepComplete(tooOld, "qbittorrent")).toBe("incomplete");
    const ok = setupReducer(base, { type: "QBIT_PROBE_RESULT", result: qbitOk });
    expect(isStepComplete(ok, "qbittorrent")).toBe("complete");
  });

  it("accepts anonymous viking but not unconfigured", () => {
    const base = completeThrough("qbit");
    const anonymous = setupReducer(base, {
      type: "VIKING_CONFIG",
      config: { mode: "anonymous", supportsAnonymous: true, requiresUserHash: false },
    });
    expect(isStepComplete(anonymous, "viking")).toBe("complete");
    const unconfigured = setupReducer(base, {
      type: "VIKING_CONFIG",
      config: { mode: "unconfigured", supportsAnonymous: true, requiresUserHash: false },
    });
    expect(isStepComplete(unconfigured, "viking")).toBe("incomplete");
  });

  it("ready step mirrors all four checks", () => {
    const almost = completeThrough("qbit");
    expect(isStepComplete(almost, "ready")).toBe("incomplete");
    const ready = setupReducer(almost, {
      type: "VIKING_CONFIG",
      config: { mode: "user_hash", supportsAnonymous: true, requiresUserHash: true },
    });
    expect(isStepComplete(ready, "ready")).toBe("complete");
    expect(setupChecklist(ready).every((row) => row.done)).toBe(true);
  });
});

describe("setupReducer navigation", () => {
  it("cannot advance past incomplete steps via NEXT (component gates) but GOTO clamps forward jumps", () => {
    const state = initialSetupState();
    const jumped = setupReducer(state, { type: "GOTO", index: 3 });
    expect(jumped.stepIndex).toBe(1); // at most one step ahead
  });

  it("BACK never goes below zero and NEXT never past the last step", () => {
    let state = setupReducer(initialSetupState(), { type: "BACK" });
    expect(state.stepIndex).toBe(0);
    for (let i = 0; i < 10; i += 1) state = setupReducer(state, { type: "NEXT" });
    expect(state.stepIndex).toBe(4);
  });

  it("saving the API key clears the plaintext input immediately", () => {
    let state = setupReducer(initialSetupState(), { type: "QBIT_KEY_INPUT", value: "supersecret" });
    state = setupReducer(state, { type: "QBIT_KEY_SAVED" });
    expect(state.qbitKeyInput).toBe("");
    expect(state.qbitKeySaved).toBe(true);
  });

  it("changing URL invalidates a previous probe", () => {
    let state = completeThrough("radmin");
    state = setupReducer(state, { type: "QBIT_PROBE_RESULT", result: qbitOk });
    state = setupReducer(state, { type: "QBIT_URL", url: "http://127.0.0.1:8081" });
    expect(state.qbitProbe).toBeNull();
    expect(state.qbitUrl).toBe("http://127.0.0.1:8081");
  });

  it("defaults to localhost Web API", () => {
    expect(initialSetupState().qbitUrl).toBe(DEFAULT_QBIT_URL);
    expect(DEFAULT_QBIT_URL).toBe("http://127.0.0.1:8080");
  });
});

describe("needsSetup", () => {
  it("true only when settings are loaded but no working folder exists", () => {
    expect(needsSetup({ settingsLoaded: true, workingFolderPath: null, healthOnline: false })).toBe(true);
    expect(needsSetup({ settingsLoaded: false, workingFolderPath: null, healthOnline: false })).toBe(false);
    expect(needsSetup({ settingsLoaded: true, workingFolderPath: "D:\\VR", healthOnline: true })).toBe(false);
  });
});
