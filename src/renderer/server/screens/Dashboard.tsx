/** Server dashboard — the appliance control panel. */

import { useMemo, useState } from "react";
import type { HistoryEntry, VikingRelayServerBridge } from "../bridge/types";
import { isRadminOffline, readinessRows } from "../domain/derive";
import { useRuntime } from "../state/RuntimeContext";
import { Button, Card, CardTitle, StatusDot } from "../components/ui";
import { ActiveTransferCard } from "./ActiveTransferCard";
import { HistoryList } from "./HistoryList";
import { PairingModal } from "./PairingModal";
import { SettingsPanel } from "./SettingsPanel";
import { StorageCard } from "./StorageCard";
import { ExitConfirmDialog, InterruptedBanner, OfflineBanner, interruptedActions } from "./banners";

const TERMINAL_STATES = new Set(["complete", "failed", "cancelled", "interrupted"]);

export function Dashboard({ bridge }: { bridge: VikingRelayServerBridge }) {
  const { health, job, history, capabilities, refreshHistory } = useRuntime();
  const [pairingOpen, setPairingOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedEntries, setArchivedEntries] = useState<HistoryEntry[]>([]);

  const toggleArchived = async (): Promise<void> => {
    const next = !showArchived;
    setShowArchived(next);
    if (next && bridge.getArchivedHistory) {
      try {
        setArchivedEntries(await bridge.getArchivedHistory(50));
      } catch {
        setArchivedEntries([]);
      }
    }
  };

  const archiveJob = async (jobId: string, archived: boolean): Promise<void> => {
    if (bridge.setJobArchived) await bridge.setJobArchived(jobId, archived);
    setArchivedEntries((list) =>
      archived ? list : list.filter((e) => e.id !== jobId),
    );
    await refreshHistory();
  };

  const rows = useMemo(() => (health ? readinessRows(health) : []), [health]);
  const offline = health ? isRadminOffline(health) : false;
  const activeJob = job && !TERMINAL_STATES.has(job.state) ? job : null;

  // Interrupted source: live job first, else most recent history entry.
  const interruptedJobId = useMemo(() => {
    if (job?.state === "interrupted") return job.id;
    const latest = history[0];
    return latest && latest.finalState === "interrupted" ? latest.id : null;
  }, [job, history]);

  const interrupted =
    interruptedJobId && capabilities
      ? interruptedActions(
          bridge,
          {
            dismissInterruptedJob: capabilities.dismissInterruptedJob,
            cleanJobData: capabilities.cleanJobData,
            openQBittorrentWebUi: capabilities.openQBittorrentWebUi,
          },
          interruptedJobId,
          () => refreshHistory(),
        )
      : null;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 px-5 py-6">
      <header className="flex items-start justify-between">
        <div>
          <p className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.22em] text-zinc-900 dark:text-zinc-50">
            Viking Relay
            <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold tracking-widest text-white">
              Server
            </span>
          </p>
          <p className="mt-1.5 flex items-center gap-2 text-sm" aria-live="polite" data-testid="online-line">
            <StatusDot state={health?.online ? "ok" : "error"} />
            {health?.online ? (
              <>
                Online
                {health.address ? (
                  <span className="font-mono text-zinc-600 dark:text-zinc-400">{health.address}</span>
                ) : null}
              </>
            ) : (
              <span className="text-zinc-500 dark:text-zinc-400">Offline</span>
            )}
          </p>
        </div>
        <Button variant="ghost" onClick={() => setExitOpen(true)} data-testid="exit-button">
          Exit
        </Button>
      </header>

      {offline ? <OfflineBanner /> : null}
      {interrupted ? <InterruptedBanner actions={interrupted} /> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_220px]">
        <div className="space-y-4">
          <Card data-testid="status-card">
            <CardTitle>Status</CardTitle>
            <div className="space-y-0.5">
              {rows.map((row) => (
                <div key={row.key} className="flex items-center justify-between py-1 text-sm" data-testid={`status-${row.key}`}>
                  <span className="flex items-center gap-2 font-medium text-zinc-700 dark:text-zinc-300">
                    <StatusDot state={row.state} />
                    {row.label}
                  </span>
                  <span className="text-zinc-600 dark:text-zinc-400">{row.detail}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <Button variant="primary" onClick={() => setPairingOpen(true)} data-testid="pair-client">
                Pair Client
              </Button>
              <Button onClick={() => setSettingsOpen(true)} data-testid="open-settings">
                Settings
              </Button>
            </div>
          </Card>

          {activeJob ? <ActiveTransferCard job={activeJob} /> : null}
          <div className="flex items-center justify-between">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={() => void toggleArchived()}
                className="h-3.5 w-3.5"
                data-testid="show-archived"
              />
              Show archived
            </label>
          </div>
          {showArchived ? (
            <HistoryList
              entries={archivedEntries}
              archived
              onCopy={bridge.copyText ? (t) => bridge.copyText!(t) : undefined}
              onArchive={archiveJob}
            />
          ) : (
            <HistoryList
              entries={history}
              onCopy={bridge.copyText ? (t) => bridge.copyText!(t) : undefined}
              onArchive={archiveJob}
            />
          )}
        </div>

        <StorageCard freeBytes={health?.storage.freeBytes ?? null} jobStorage={activeJob?.storage ?? null} />
      </div>

      <PairingModal open={pairingOpen} onClose={() => setPairingOpen(false)} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} bridge={bridge} />
      <ExitConfirmDialog
        open={exitOpen}
        jobActive={!!activeJob}
        onCancel={() => setExitOpen(false)}
        onConfirmExit={() => {
          setExitOpen(false);
          void bridge.requestAppExit();
        }}
      />
    </div>
  );
}
