/**
 * Server Mode app root. Chooses setup vs dashboard and gates on bridge
 * availability with a clear message instead of a blank window.
 */

import { getServerBridge } from "./bridge/serverBridge";
import type { VikingRelayServerBridge } from "./bridge/types";
import { RuntimeProvider, useRuntime } from "./state/RuntimeContext";
import { needsSetup } from "./state/setupMachine";
import { Banner } from "./components/ui";
import { Dashboard } from "./screens/Dashboard";
import { SetupWizard } from "./screens/setup/SetupWizard";

export function ServerApp({ bridge }: { bridge: VikingRelayServerBridge | null }) {
  if (!bridge) {
    return (
      <div className="mx-auto max-w-xl px-6 py-16">
        <Banner tone="error">
          Viking Relay could not reach its local service. Restart the app, and if the problem
          persists reinstall Viking Relay.
        </Banner>
      </div>
    );
  }
  return (
    <RuntimeProvider bridge={bridge}>
      <Gate bridge={bridge} />
    </RuntimeProvider>
  );
}

function Gate({ bridge }: { bridge: VikingRelayServerBridge }) {
  const { loaded, settings, health } = useRuntime();

  if (!loaded) {
    return (
      <div className="flex min-h-screen items-center justify-center" aria-busy="true">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Starting Viking Relay…</p>
      </div>
    );
  }

  const firstRun = needsSetup({
    settingsLoaded: loaded,
    workingFolderPath: settings?.workingFolderPath ?? null,
    healthOnline: health ? health.online : null,
  });

  return firstRun ? (
    <SetupWizard bridge={bridge} onComplete={() => undefined} />
  ) : (
    <Dashboard bridge={bridge} />
  );
}

/** Entry helper used by index.tsx; allows tests to inject a bridge. */
export function mountServerApp(target: HTMLElement, bridge?: VikingRelayServerBridge | null): void {
  const resolved = bridge === undefined ? getServerBridge() : bridge;
  const root = (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
      <ServerApp bridge={resolved} />
    </div>
  );
  // createRoot is imported lazily to keep this module importable in tests.
  import("react-dom/client").then(({ createRoot }) => {
    createRoot(target).render(root);
  });
}
