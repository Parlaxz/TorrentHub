/**
 * Global settings — available in BOTH modes from the shell header.
 * Currently hosts the in-app updater; app-wide concerns belong here.
 */
import { useEffect, useState } from 'react'
import type { UpdateState } from '@shared/ipc'

export function GlobalSettingsModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || !window.vikingRelay) return
    let cancelled = false
    void window.vikingRelay
      .getUpdateState()
      .then((s) => {
        if (!cancelled) setUpdateState(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    const active = updateState?.phase === 'checking' || updateState?.phase === 'downloading'
    if (!open || !active) return
    const timer = setInterval(() => {
      void window.vikingRelay
        ?.getUpdateState()
        .then(setUpdateState)
        .catch(() => {})
    }, 1000)
    return () => clearInterval(timer)
  }, [open, updateState?.phase])

  if (!open) return null

  const check = async (): Promise<void> => {
    setBusy(true)
    try {
      setUpdateState(await window.vikingRelay.checkForUpdates())
    } finally {
      setBusy(false)
    }
  }

  const install = async (): Promise<void> => {
    await window.vikingRelay.installUpdate()
  }

  const statusText = updateState
    ? updateState.disabled
      ? `Viking Relay v${updateState.currentVersion} — updates are disabled in development builds.`
      : updateState.phase === 'checking'
        ? 'Checking for updates…'
        : updateState.phase === 'downloading'
          ? `Downloading v${updateState.availableVersion ?? '…'} — ${updateState.progressPct ?? 0}%`
          : updateState.phase === 'downloaded'
            ? `v${updateState.availableVersion} is ready. Restart to install.`
            : updateState.phase === 'error'
              ? `Update check failed: ${updateState.error ?? 'unknown error'}`
              : updateState.phase === 'not-available'
                ? `You're on the latest version (v${updateState.currentVersion}).`
                : `Viking Relay v${updateState.currentVersion} — up to date.`
    : '…'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={onClose}
      data-testid="global-settings-modal"
    >
      <div
        className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-5 text-neutral-200 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Settings</h2>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            onClick={onClose}
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        <div className="mt-4" data-testid="global-updates-section">
          <h3 className="text-sm font-semibold text-neutral-100">Updates</h3>
          <p className="mt-1 text-xs text-neutral-400" data-testid="global-update-status">
            {statusText}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={
                busy || updateState?.phase === 'checking' || updateState?.phase === 'downloading'
              }
              onClick={() => void check()}
              className="rounded border border-neutral-700 px-3 py-1 text-sm hover:bg-neutral-800 disabled:opacity-50"
              data-testid="global-check-updates"
            >
              Check for updates
            </button>
            {updateState?.phase === 'downloaded' ? (
              <button
                type="button"
                onClick={() => void install()}
                className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-500"
                data-testid="global-install-update"
              >
                Restart to update
              </button>
            ) : null}
          </div>
        </div>

        <p className="mt-5 text-xs text-neutral-500">
          Detailed logs: <span className="font-mono">%APPDATA%\Viking Relay\logs\</span> — errors
          also appear in this window's DevTools console.
        </p>
        <button
          type="button"
          onClick={() => void window.vikingRelay.openLogsFolder()}
          className="mt-2 rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800"
          data-testid="open-logs-folder"
        >
          Open logs folder
        </button>
      </div>
    </div>
  )
}
