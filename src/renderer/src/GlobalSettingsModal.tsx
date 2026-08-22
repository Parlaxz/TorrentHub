/**
 * Global settings — available in BOTH modes from the shell header.
 * Hosts the in-app updater and, in Client mode, the "friend" receiver
 * settings (direct downloads from the paired server).
 */
import { useEffect, useState } from 'react'
import type { UpdateState } from '@shared/ipc'

interface DdState {
  settings: { autoAccept: boolean; qbitUrl: string; qbitKeySet: boolean; downloadDir: string | null }
  queue: Array<{ id: string; source: string; sourceKind: string; state: string; error?: string | null }>
}

export function GlobalSettingsModal({
  open,
  onClose,
  mode,
}: {
  open: boolean
  onClose: () => void
  mode: 'client' | 'server' | null
}): React.JSX.Element | null {
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)
  const [dd, setDd] = useState<DdState | null>(null)
  const [qbitUrlDraft, setQbitUrlDraft] = useState('')
  const [keyDraft, setKeyDraft] = useState('')
  const [dirDraft, setDirDraft] = useState('')

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
    if (!open || mode !== 'client' || !window.vikingRelay?.getDirectDownloadsState) return
    let cancelled = false
    void window.vikingRelay
      .getDirectDownloadsState()
      .then((s) => {
        if (cancelled) return
        setDd(s)
        setQbitUrlDraft(s.settings.qbitUrl)
        setDirDraft(s.settings.downloadDir ?? '')
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open, mode])

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

  const saveDd = async (patch: {
    autoAccept?: boolean
    qbitUrl?: string
    qbitKey?: string
    downloadDir?: string | null
  }): Promise<void> => {
    if (!window.vikingRelay?.setDirectDownloadSettings) return
    await window.vikingRelay.setDirectDownloadSettings(patch)
    try {
      const next = await window.vikingRelay.getDirectDownloadsState()
      setDd(next)
      setQbitUrlDraft(next.settings.qbitUrl)
      setDirDraft(next.settings.downloadDir ?? '')
    } catch {
      /* ignore */
    }
  }

  const refreshQueue = async (): Promise<void> => {
    if (!window.vikingRelay?.refreshDirectDownloads) return
    await window.vikingRelay.refreshDirectDownloads().catch(() => {})
    try {
      setDd(await window.vikingRelay.getDirectDownloadsState())
    } catch {
      /* ignore */
    }
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
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900 p-5 text-neutral-200 shadow-xl"
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

        {mode === 'client' && dd ? (
          <div className="mt-6 border-t border-neutral-800 pt-4" data-testid="direct-downloads-section">
            <h3 className="text-sm font-semibold text-neutral-100">Direct downloads</h3>
            <p className="mt-1 text-xs text-neutral-400">
              Links sent by your paired server land here and download on THIS PC.
            </p>

            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={dd.settings.autoAccept}
                onChange={(e) => void saveDd({ autoAccept: e.target.checked })}
                className="h-4 w-4"
                data-testid="dd-auto-accept"
              />
              Trust downloads automatically (off = queue for approval)
            </label>

            <div className="mt-3 space-y-2 text-xs">
              <input
                value={qbitUrlDraft}
                onChange={(e) => setQbitUrlDraft(e.target.value)}
                placeholder="Your qBittorrent WebUI URL (http://127.0.0.1:8080)"
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-neutral-200"
                data-testid="dd-qbit-url"
              />
              <input
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder={dd.settings.qbitKeySet ? 'API key saved ✓' : 'qBittorrent API key'}
                autoComplete="off"
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-neutral-200"
                data-testid="dd-qbit-key"
              />
              <input
                value={dirDraft}
                onChange={(e) => setDirDraft(e.target.value)}
                placeholder="Download folder (D:\\Downloads)"
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-neutral-200"
                data-testid="dd-download-dir"
              />
              <button
                type="button"
                onClick={() =>
                  void saveDd({
                    qbitUrl: qbitUrlDraft,
                    ...(keyDraft.trim() ? { qbitKey: keyDraft.trim() } : {}),
                    downloadDir: dirDraft.trim() || null,
                  })
                }
                className="rounded border border-neutral-700 px-3 py-1 hover:bg-neutral-800"
                data-testid="dd-save"
              >
                Save receiver settings
              </button>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Received
                </h4>
                <button
                  type="button"
                  onClick={() => void refreshQueue()}
                  className="text-xs text-neutral-400 underline-offset-2 hover:underline"
                  data-testid="dd-refresh"
                >
                  Refresh
                </button>
              </div>
              {dd.queue.length === 0 ? (
                <p className="mt-1 text-xs text-neutral-500" data-testid="dd-empty">
                  Nothing received yet.
                </p>
              ) : (
                <ul className="mt-1 space-y-2" data-testid="dd-queue">
                  {dd.queue.map((item) => (
                    <li
                      key={item.id}
                      className="rounded border border-neutral-800 px-2 py-1.5 text-xs"
                      data-testid={`dd-item-${item.id}`}
                    >
                      <p className="truncate font-mono text-neutral-300">{item.source}</p>
                      <p className="mt-0.5 text-neutral-500">
                        {item.state}
                        {item.error ? ` — ${item.error}` : ''}
                      </p>
                      {item.state === 'pending' ? (
                        <div className="mt-1 flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              void window.vikingRelay.acceptDirectDownload(item.id).then(refreshQueue)
                            }}
                            className="rounded bg-emerald-600 px-2 py-0.5 font-medium text-white hover:bg-emerald-500"
                            data-testid={`dd-accept-${item.id}`}
                          >
                            Download
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              void window.vikingRelay.declineDirectDownload(item.id).then(refreshQueue)
                            }}
                            className="rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800"
                            data-testid={`dd-decline-${item.id}`}
                          >
                            Decline
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}

        <p className="mt-6 text-xs text-neutral-500">
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
