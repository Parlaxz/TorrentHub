/**
 * Access seam to the SHELL bridge (`window.vikingRelay`) for app-wide
 * concerns like updates. Keeps direct `window` access out of screens.
 */
import type { UpdateState } from "@shared/ipc";

export interface ShellUpdateBridge {
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  installUpdate(): Promise<UpdateState>;
}

export function getShellUpdateBridge(): ShellUpdateBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.vikingRelay;
  if (!bridge || typeof bridge.checkForUpdates !== "function") return null;
  return {
    getUpdateState: () => bridge.getUpdateState(),
    checkForUpdates: () => bridge.checkForUpdates(),
    installUpdate: () => bridge.installUpdate(),
  };
}
