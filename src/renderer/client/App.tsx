import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ActiveJobScreen } from "./screens/ActiveJobScreen";
import { CompleteScreen } from "./screens/CompleteScreen";
import { ConnectScreen } from "./screens/ConnectScreen";
import { ErrorScreen } from "./screens/ErrorScreen";
import { HistoryScreen } from "./screens/HistoryScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { MetadataScreen } from "./screens/MetadataScreen";
import { SelectionScreen } from "./screens/SelectionScreen";
import { Button, EmptyState, Panel, StatusDot } from "./components/ui";
import { getBridge, type ConnectionStatus, type SavedConnection } from "./lib/bridge";
import { classifyJobFailure, type ClientErrorKind } from "./lib/errors";
import { usePolling } from "./lib/usePolling";
import { isTerminalJobState, type HistoryEntry, type IntakeDraftView, type JobSnapshot } from "./types";

type Phase =
  | { s: "boot" }
  | { s: "no_bridge" }
  | { s: "connect"; mode: "initial" | "change" }
  | { s: "home" }
  | { s: "intake"; jobId: string; sourceKind: "magnet" | "url" | null }
  | { s: "selection"; draft: IntakeDraftView }
  | { s: "active"; jobId: string }
  | { s: "complete"; job: JobSnapshot }
  | { s: "error"; kind: ClientErrorKind; message?: string | null; jobId?: string }
  | { s: "history" };

export function App() {
  const bridge = useMemo(getBridge, []);
  const [phase, setPhase] = useState<Phase>({ s: "boot" });
  const [saved, setSaved] = useState<SavedConnection | null>(null);
  const [connStatus, setConnStatus] = useState<ConnectionStatus | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [latestJob, setLatestJob] = useState<JobSnapshot | null>(null);

  // Boot: load saved connection (main owns secrets).
  useEffect(() => {
    if (!bridge) {
      setPhase({ s: "no_bridge" });
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const c = await bridge.getConnection();
        if (!alive) return;
        setSaved(c);
        setPhase(c ? { s: "home" } : { s: "connect", mode: "initial" });
      } catch {
        if (alive) setPhase({ s: "connect", mode: "initial" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [bridge]);

  // Connection status: push events + gentle refresh poll.
  useEffect(() => {
    if (!bridge) return;
    const off = bridge.onConnectionChanged?.((status) => setConnStatus(status));
    const id = window.setInterval(() => {
      void bridge
        .connectionStatus()
        .then(setConnStatus)
        .catch(() =>
          setConnStatus((prev) => ({ state: prev?.state === "unpaired" ? "unpaired" : "offline" })),
        );
    }, 3000);
    void bridge.connectionStatus().then(setConnStatus).catch(() => {});
    return () => {
      off?.();
      window.clearInterval(id);
    };
  }, [bridge]);

  // Draft polling while reading metadata (~700ms).
  usePolling<IntakeDraftView>({
    enabled: phase.s === "intake",
    intervalMs: 700,
    fn: () => bridge!.getDraft((phase as { jobId: string }).jobId),
    onData: (draft) => {
      if (draft.state === "awaiting_selection" && draft.metadata) {
        setPhase({ s: "selection", draft });
      } else if (draft.state === "failed") {
        setPhase({
          s: "error",
          kind: draft.error ? classifyJobFailure({ state: "failed", error: draft.error }) : "unknown",
          message: draft.error?.message ?? null,
          jobId: draft.id,
        });
      }
    },
  });

  // Active-job polling (~1/s). A failed poll never cancels server work.
  const jobPollStatus = usePolling<JobSnapshot>({
    enabled: phase.s === "active",
    intervalMs: 1000,
    fn: () => bridge!.getJob((phase as { jobId: string }).jobId),
    onData: (job) => {
      setLatestJob(job);
      if (!isTerminalJobState(job.state)) return;
      if (job.state === "complete") setPhase({ s: "complete", job });
      else
        setPhase({
          s: "error",
          kind: classifyJobFailure(job),
          message: job.error?.message ?? null,
          jobId: job.id,
        });
    },
  });

  const submitIntake = useCallback(
    async (input: string): Promise<void> => {
      if (!bridge) return;
      setSubmitBusy(true);
      setSubmitError(null);
      try {
        const { jobId } = await bridge.createIntake(input);
        const sourceKind = input.startsWith("magnet:") ? "magnet" : "url";
        setPhase({ s: "intake", jobId, sourceKind });
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : "Could not submit this torrent.");
      } finally {
        setSubmitBusy(false);
      }
    },
    [bridge],
  );

  const cancelJob = useCallback(
    async (jobId: string): Promise<void> => {
      if (!bridge) return;
      try {
        await bridge.cancelJob(jobId);
      } finally {
        setLatestJob(null);
        setPhase({ s: "home" });
      }
    },
    [bridge],
  );

  const openHistory = useCallback(async (): Promise<void> => {
    if (!bridge) return;
    setHistory(null);
    setPhase({ s: "history" });
    try {
      setHistory(await bridge.listHistory());
    } catch {
      setHistory([]);
    }
  }, [bridge]);

  if (!bridge || phase.s === "no_bridge") {
    return (
      <Shell chrome={false}>
        <div className="mx-auto w-full max-w-md px-6 py-10">
          <Panel>
            <EmptyState
              title="Viking Relay shell required"
              detail="This interface runs inside the Viking Relay desktop app. Launch the app instead of opening this file in a browser."
            />
          </Panel>
        </div>
      </Shell>
    );
  }

  if (phase.s === "boot") {
    return (
      <Shell chrome={false}>
        <EmptyState title="Starting…" />
      </Shell>
    );
  }

  const showChrome = phase.s !== "connect";

  return (
    <Shell
      chrome={showChrome}
      connStatus={connStatus}
      saved={saved}
      onChangeServer={() => setPhase({ s: "connect", mode: "change" })}
      onHistory={() => void openHistory()}
      notice={submitError}
    >
      {phase.s === "connect" ? (
        <ConnectScreen
          bridge={bridge}
          mode={phase.mode}
          saved={saved}
          onCancel={phase.mode === "change" ? () => setPhase({ s: "home" }) : undefined}
          onPaired={(conn) => {
            setSaved(conn);
            setSubmitError(null);
            setPhase({ s: "home" });
          }}
        />
      ) : null}

      {phase.s === "home" ? (
        <HomeScreen
          connection={connStatus}
          busy={submitBusy}
          error={submitError}
          onSubmit={(input) => void submitIntake(input)}
        />
      ) : null}

      {phase.s === "intake" ? (
        <MetadataScreen sourceKind={phase.sourceKind} onCancel={() => void cancelJob(phase.jobId)} />
      ) : null}

      {phase.s === "selection" ? (
        <SelectionScreen
          bridge={bridge}
          draft={phase.draft}
          onBack={() => {
            void cancelJob(phase.draft.id);
          }}
          onStarted={() => setPhase({ s: "active", jobId: phase.draft.id })}
        />
      ) : null}

      {phase.s === "active" ? (
        latestJob && latestJob.id === phase.jobId ? (
          <ActiveJobScreen
            job={latestJob}
            pollStatus={jobPollStatus}
            onCancel={() => void cancelJob(phase.jobId)}
            onRetryPackaging={() => void bridge.retryPackaging(phase.jobId)}
            onRetryUpload={() => void bridge.retryUpload(phase.jobId)}
          />
        ) : (
          <EmptyState title="Connecting to job…" />
        )
      ) : null}

      {phase.s === "complete" ? (
        <CompleteScreen
          bridge={bridge}
          filename={phase.job.metadata?.name ?? "Download"}
          sizeBytes={phase.job.result?.sizeBytes ?? phase.job.metadata?.totalSizeBytes ?? null}
          url={phase.job.result?.url ?? ""}
          directUrl={phase.job.result?.directUrl ?? null}
          onNewTorrent={() => {
            setLatestJob(null);
            setPhase({ s: "home" });
          }}
        />
      ) : null}

      {phase.s === "error" ? (
        <ErrorScreen
          kind={phase.kind}
          message={phase.message}
          onRetryPackaging={
            phase.jobId
              ? () => {
                  setPhase({ s: "active", jobId: phase.jobId! });
                  void bridge.retryPackaging(phase.jobId!);
                }
              : undefined
          }
          onRetryUpload={
            phase.jobId
              ? () => {
                  setPhase({ s: "active", jobId: phase.jobId! });
                  void bridge.retryUpload(phase.jobId!);
                }
              : undefined
          }
          onBack={() => {
            setLatestJob(null);
            setPhase({ s: "home" });
          }}
        />
      ) : null}

      {phase.s === "history" ? (
        <HistoryScreen bridge={bridge} entries={history} onClose={() => setPhase({ s: "home" })} />
      ) : null}
    </Shell>
  );
}

function Shell({
  children,
  chrome,
  connStatus,
  saved,
  onChangeServer,
  onHistory,
  notice,
}: {
  children: ReactNode;
  chrome: boolean;
  connStatus?: ConnectionStatus | null;
  saved?: SavedConnection | null;
  onChangeServer?: () => void;
  onHistory?: () => void;
  notice?: string | null;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {chrome ? (
        <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
          <div className="mx-auto flex h-11 w-full max-w-2xl items-center gap-3 px-6">
            <span className="text-[13px] font-black tracking-[0.18em]">VIKING RELAY</span>
            {connStatus ? (
              <span className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                <StatusDot state={connStatus.state} />
                <span className="capitalize">{connStatus.state}</span>
              </span>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              {onHistory ? (
                <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onHistory}>
                  History
                </Button>
              ) : null}
              {onChangeServer && saved ? (
                <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onChangeServer}>
                  Change Server
                </Button>
              ) : null}
            </div>
          </div>
          {notice ? (
            <p role="alert" className="bg-red-600 px-6 py-1 text-center text-xs font-medium text-white">
              {notice}
            </p>
          ) : null}
        </header>
      ) : null}
      <main className="flex-1">{children}</main>
    </div>
  );
}
