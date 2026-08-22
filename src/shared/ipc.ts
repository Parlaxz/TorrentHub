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
  secretDelete: 'secrets:delete'
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
}

export { AppModeSchema, AppSettingsPatchSchema, SecretKeySchema, SecretValueSchema }
