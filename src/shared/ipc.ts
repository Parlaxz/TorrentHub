import { z } from 'zod'
import type { AppMode } from './domain'
import { AppModeSchema } from './domain'
import type { AppSettings, AppSettingsPatch } from './settings'
import { AppSettingsPatchSchema } from './settings'

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const IpcChannels = {
  appGetState: 'app:getState',
  appSetMode: 'app:setMode',
  settingsUpdate: 'app:updateSettings',
  secretSet: 'secrets:set',
  secretGet: 'secrets:get',
  secretDelete: 'secrets:delete',
  updatesGetState: 'updates:getState',
  updatesCheck: 'updates:check',
  updatesInstall: 'updates:install',
  openLogsFolder: 'app:openLogsFolder',
  ddGetState: 'dd:getState',
  ddSetSettings: 'dd:setSettings',
  ddAccept: 'dd:accept',
  ddDecline: 'dd:decline',
  ddRefresh: 'dd:refresh',
  openExternal: 'app:openExternal'
} as const

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export const AppStateSchema = z.object({
  mode: AppModeSchema.nullable(),
  settings: z.custom<AppSettings>((v) => v !== null && typeof v === 'object'),
  versions: z.object({
    app: z.string(),
    electron: z.string(),
    chrome: z.string(),
    node: z.string()
  })
})
export type AppState = z.infer<typeof AppStateSchema>

// ---------------------------------------------------------------------------
// In-app updates
// ---------------------------------------------------------------------------

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  availableVersion: string | null
  /** 0-100 while downloading; 100 once downloaded. */
  progressPct: number | null
  error: string | null
  /** True in dev builds — the updater only runs when packaged. */
  disabled: boolean
}

const SecretKeySchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9._-]+$/, 'secret keys may contain letters, digits, dot, dash, underscore')
const SecretValueSchema = z.string().min(1)

// ---------------------------------------------------------------------------
// Preload bridge surface (the ONLY API the renderer gets)
// ---------------------------------------------------------------------------

export interface SecretStoreBridge {
  /** Stores an encrypted copy of `value`; returns false if encryption is unavailable. */
  set(key: string, value: string): Promise<boolean>
  get(key: string): Promise<string | null>
  remove(key: string): Promise<boolean>
}

export interface VikingRelayBridge {
  getState(): Promise<AppState>
  setMode(mode: AppMode): Promise<AppState>
  updateSettings(patch: AppSettingsPatch): Promise<AppSettings>
  secrets: SecretStoreBridge
  getUpdateState(): Promise<UpdateState>
  /** Triggers a check (and background download when one is available). */
  checkForUpdates(): Promise<UpdateState>
  /** Applies a downloaded update by restarting the app. */
  installUpdate(): Promise<UpdateState>
  /** Opens the logs folder in the OS file explorer. */
  openLogsFolder(): Promise<boolean>
  /** Opens an http(s) URL in the system browser. Non-http(s) is refused. */
  openExternal(url: string): Promise<boolean>
  /** Main-process log mirror (warn/error) so failures reach the DevTools console. */
  onLog(cb: (entry: { level: 'warn' | 'error' | 'info'; msg: string }) => void): () => void
  /** Client mode "friend" receiver: settings + local queue. */
  getDirectDownloadsState(): Promise<{
    settings: { autoAccept: boolean; qbitUrl: string; qbitKeySet: boolean; downloadDir: string | null }
    queue: Array<{ id: string; source: string; sourceKind: string; state: string; error?: string | null }>
  }>
  setDirectDownloadSettings(patch: {
    autoAccept?: boolean
    qbitUrl?: string
    qbitKey?: string
    downloadDir?: string | null
  }): Promise<void>
  acceptDirectDownload(id: string): Promise<void>
  declineDirectDownload(id: string): Promise<void>
  refreshDirectDownloads(): Promise<void>
}

declare global {
  interface Window {
    vikingRelay: VikingRelayBridge
  }
}

// ---------------------------------------------------------------------------
// Main-process handler signatures (implemented in src/main/ipc.ts)
// ---------------------------------------------------------------------------

export interface IpcHandlers {
  [IpcChannels.appGetState]: () => Promise<AppState>
  [IpcChannels.appSetMode]: (mode: AppMode) => Promise<AppState>
  [IpcChannels.settingsUpdate]: (patch: AppSettingsPatch) => Promise<AppSettings>
  [IpcChannels.secretSet]: (key: string, value: string) => Promise<boolean>
  [IpcChannels.secretGet]: (key: string) => Promise<string | null>
  [IpcChannels.secretDelete]: (key: string) => Promise<boolean>
  [IpcChannels.updatesGetState]: () => Promise<UpdateState>
  [IpcChannels.updatesCheck]: () => Promise<UpdateState>
  [IpcChannels.updatesInstall]: () => Promise<UpdateState>
  [IpcChannels.openLogsFolder]: () => Promise<boolean>
  [IpcChannels.ddGetState]: () => Promise<{
    settings: { autoAccept: boolean; qbitUrl: string; qbitKeySet: boolean; downloadDir: string | null }
    queue: Array<{ id: string; source: string; sourceKind: string; state: string; error?: string | null }>
  }>
  [IpcChannels.ddSetSettings]: (patch: {
    autoAccept?: boolean
    qbitUrl?: string
    qbitKey?: string
    downloadDir?: string | null
  }) => Promise<void>
  [IpcChannels.ddAccept]: (id: string) => Promise<void>
  [IpcChannels.ddDecline]: (id: string) => Promise<void>
  [IpcChannels.ddRefresh]: () => Promise<void>
  [IpcChannels.openExternal]: (url: string) => Promise<boolean>
}

export { AppModeSchema, AppSettingsPatchSchema, SecretKeySchema, SecretValueSchema }
