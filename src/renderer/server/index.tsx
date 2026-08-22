import { getServerBridge } from "./bridge/serverBridge";
import { MockServerBridge } from "./bridge/mockServerBridge";
import { ServerApp } from "./App";
import "./styles.css";

/**
 * Client Mode entry. The renderer shell (`src/renderer/src/App.tsx`) imports
 * this module as `ServerApp` and mounts it inside its own chrome — this
 * component must NOT mount itself or own the document root.
 *
 * The `?demo=1` mock bridge is a development-only preview aid and is compiled
 * out of production bundles (dead-code eliminated by the bundler).
 */
export default function ServerModeApp() {
  let bridge = getServerBridge();
  if (!bridge && import.meta.env.DEV) {
    const demo = new URLSearchParams(window.location.search).has("demo");
    if (demo) bridge = new MockServerBridge();
  }
  return <ServerApp bridge={bridge} />;
}
