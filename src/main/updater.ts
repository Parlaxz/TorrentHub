/**
 * In-app auto-update on top of electron-updater + GitHub releases.
 *
 * Behavior: check on startup (packaged builds only), download in the
 * background, then let the user "Restart to update" (or install silently on
 * quit). All state is exposed to the renderer as a plain snapshot via IPC —
 * no raw events cross the bridge.
 */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { Logger } from 'pino'
import type { UpdateState } from '@shared/ipc'

export type UpdateChannel = 'stable' | 'beta'

export class AppUpdater {
  private readonly log: Logger
  private state: UpdateState

  constructor(log: Logger, currentVersion: string, channel: UpdateChannel = 'stable') {
    this.log = log
    this.state = {
      phase: 'idle',
      currentVersion,
      availableVersion: null,
      progressPct: null,
      error: null,
      disabled: !app.isPackaged,
      channel,
    }
    if (this.state.disabled) return

    autoUpdater.channel = channel
    // Required so switching beta -> stable can install the lower stable
    // version over an installed prerelease.
    autoUpdater.allowDowngrade = true
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = {
      info: (m) => this.log.info({ m }, 'auto-update'),
      warn: (m) => this.log.warn({ m }, 'auto-update'),
      error: (m) => this.log.error({ m }, 'auto-update'),
      debug: (m) => this.log.debug({ m }, 'auto-update'),
    }

    autoUpdater.on('checking-for-update', () => {
      this.set({ phase: 'checking', error: null })
    })
    autoUpdater.on('update-available', (info) => {
      this.log.info({ version: info.version }, 'update available; downloading')
      this.set({ phase: 'downloading', availableVersion: info.version ?? null, progressPct: 0 })
    })
    autoUpdater.on('update-not-available', () => {
      this.set({ phase: 'not-available', availableVersion: null, progressPct: null })
    })
    autoUpdater.on('download-progress', (p) => {
      this.set({
        phase: 'downloading',
        progressPct: typeof p.percent === 'number' ? Math.round(p.percent) : null,
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.log.info({ version: info.version }, 'update downloaded; restart to apply')
      this.set({
        phase: 'downloaded',
        availableVersion: info.version ?? this.state.availableVersion,
        progressPct: 100,
      })
    })
    autoUpdater.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err)
      this.log.warn({ err: message }, 'auto-update error')
      this.set({ phase: 'error', error: message })
    })
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
  }

  getState(): UpdateState {
    return { ...this.state }
  }

  async check(): Promise<UpdateState> {
    if (this.state.disabled) return this.getState()
    if (this.state.phase === 'checking' || this.state.phase === 'downloading') {
      return this.getState()
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // The 'error' event already recorded the failure.
    }
    return this.getState()
  }

  /**
   * Switches the update feed channel and immediately re-checks so the
   * effect is visible without an app restart. allowDowngrade (set in the
   * constructor) makes beta -> stable downgrades installable.
   */
  async setChannel(channel: UpdateChannel): Promise<UpdateState> {
    if (channel !== this.state.channel) {
      this.log.info({ from: this.state.channel, to: channel }, 'update channel changed')
    }
    this.set({ channel })
    if (!this.state.disabled) {
      autoUpdater.channel = channel
      await this.check()
    }
    return this.getState()
  }

  /** Runs the app's update on quit; only valid once an update is downloaded. */
  install(): UpdateState {
    if (this.state.phase === 'downloaded') {
      autoUpdater.quitAndInstall(false, true)
    }
    return this.getState()
  }

  /** Fire-and-forget startup check; failures are logged, never thrown. */
  checkOnStartup(): void {
    if (this.state.disabled) return
    setTimeout(() => {
      void this.check()
    }, 5_000).unref?.()
  }
}
