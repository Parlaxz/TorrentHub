/**
 * Access seam to preload/main.
 *
 * The ONLY module allowed to look at `window`. Everything else in Server Mode
 * receives a `VikingRelayServerBridge` via context/props, which keeps the
 * renderer testable and lets integration swap the real preload in one place.
 */

import type { VikingRelayServerBridge } from "./types";

declare global {
  interface Window {
    vikingRelayServer?: VikingRelayServerBridge;
  }
}

export function getServerBridge(): VikingRelayServerBridge | null {
  if (typeof window === "undefined") return null;
  return window.vikingRelayServer ?? null;
}

export class BridgeUnavailableError extends Error {
  constructor() {
    super(
      "Viking Relay server bridge is not available. Preload script did not expose window.vikingRelayServer.",
    );
    this.name = "BridgeUnavailableError";
  }
}

export function requireServerBridge(): VikingRelayServerBridge {
  const bridge = getServerBridge();
  if (!bridge) throw new BridgeUnavailableError();
  return bridge;
}
