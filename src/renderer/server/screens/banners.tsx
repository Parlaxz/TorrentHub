/** Offline, interrupted-job, and exit-confirmation flows. */

import type { VikingRelayServerBridge } from "../bridge/types";
import { RADMIN_OFFLINE_MESSAGE } from "../domain/derive";
import { Banner, Button, Modal } from "../components/ui";

export function OfflineBanner() {
  return (
    <Banner tone="warn" data-testid="offline-banner">
      <span className="font-semibold">Radmin · Disconnected.</span> {RADMIN_OFFLINE_MESSAGE}
    </Banner>
  );
}

export interface InterruptedActions {
  onDismiss?: () => void;
  onCleanJobData?: () => void;
  onOpenQBittorrent?: () => void;
}

export function InterruptedBanner({ actions }: { actions: InterruptedActions }) {
  const hasActions = actions.onDismiss || actions.onCleanJobData || actions.onOpenQBittorrent;
  return (
    <Banner
      tone="error"
      data-testid="interrupted-banner"
      actions={
        hasActions ? (
          <>
            {actions.onOpenQBittorrent ? (
              <Button onClick={actions.onOpenQBittorrent}>Open qBittorrent</Button>
            ) : null}
            {actions.onCleanJobData ? (
              <Button onClick={actions.onCleanJobData}>Clean up job data</Button>
            ) : null}
            {actions.onDismiss ? <Button variant="ghost" onClick={actions.onDismiss}>Dismiss</Button> : null}
          </>
        ) : undefined
      }
    >
      Previous transfer was interrupted when Viking Relay stopped unexpectedly. Automatic resume is
      not supported.
    </Banner>
  );
}

export function ExitConfirmDialog({
  open,
  jobActive,
  onCancel,
  onConfirmExit,
}: {
  open: boolean;
  jobActive: boolean;
  onCancel: () => void;
  onConfirmExit: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={jobActive ? "Exit with a transfer running?" : "Exit Viking Relay?"}>
      <div className="space-y-4 text-sm text-zinc-600 dark:text-zinc-300">
        {jobActive ? (
          <p data-testid="exit-active-warning">
            A transfer is active. Exiting stops it and marks the job{" "}
            <strong className="text-zinc-800 dark:text-zinc-100">interrupted</strong>. Automatic
            resume is not supported.
          </p>
        ) : (
          <p>The server will stop accepting Client connections until started again.</p>
        )}
        <p className="rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
          Tip: closing the Server window only hides it to the tray — transfers keep running.
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} data-testid="exit-cancel">
            Keep running
          </Button>
          <Button variant="danger" onClick={onConfirmExit} data-testid="exit-confirm">
            Exit anyway
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Builds interrupted-banner actions strictly from real backend capabilities. */
export function interruptedActions(
  bridge: VikingRelayServerBridge,
  capabilities: { dismissInterruptedJob: boolean; cleanJobData: boolean; openQBittorrentWebUi: boolean },
  jobId: string,
  refreshHistory: () => Promise<void>,
): InterruptedActions {
  const actions: InterruptedActions = {};
  if (capabilities.dismissInterruptedJob && bridge.dismissInterruptedJob) {
    actions.onDismiss = () => {
      void bridge.dismissInterruptedJob?.(jobId).then(refreshHistory);
    };
  }
  if (capabilities.cleanJobData && bridge.cleanJobData) {
    actions.onCleanJobData = () => {
      void bridge.cleanJobData?.(jobId).then(refreshHistory);
    };
  }
  if (capabilities.openQBittorrentWebUi && bridge.openQBittorrentWebUi) {
    actions.onOpenQBittorrent = () => {
      void bridge.openQBittorrentWebUi?.();
    };
  }
  return actions;
}
