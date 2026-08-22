import { ipcMain, shell } from 'electron'
import type { AppState, IpcHandlers, UpdateState } from '@shared/ipc'
import { AppModeSchema, IpcChannels, SecretKeySchema, SecretValueSchema } from '@shared/ipc'
import { AppSettingsPatchSchema } from '@shared/settings'
import type { Logger } from 'pino'
import type { SecretStore } from './secrets'
import type { AppSettingsStore } from './settings-store'
import type { AppUpdater } from './updater'

interface IpcContext {
  store: AppSettingsStore
  secrets: SecretStore
  log: Logger
  versions: AppState['versions']
  updater: AppUpdater
  logsDir: string
}

function badRequest(message: string): Error {
  return new Error(`bad_request: ${message}`)
}

export function registerIpcHandlers(ctx: IpcContext): void {
  const handlers: IpcHandlers = {
    [IpcChannels.appGetState]: async () => ({
      mode: ctx.store.get().mode,
      settings: ctx.store.get(),
      versions: ctx.versions
    }),

    [IpcChannels.appSetMode]: async (rawMode) => {
      const mode = AppModeSchema.parse(rawMode)
      ctx.store.update({ mode })
      ctx.log.info({ mode }, 'app mode set')
      return handlers[IpcChannels.appGetState]()
    },

    [IpcChannels.settingsUpdate]: async (rawPatch) => {
      const patch = AppSettingsPatchSchema.parse(rawPatch)
      const next = ctx.store.update(patch)
      ctx.log.info({ patch: Object.keys(patch) }, 'settings updated')
      return next
    },

    [IpcChannels.secretSet]: async (rawKey, rawValue) => {
      const key = SecretKeySchema.parse(rawKey)
      const value = SecretValueSchema.parse(rawValue)
      const ok = ctx.secrets.set(key, value)
      ctx.log.info({ key, ok }, 'secret set')
      return ok
    },

    [IpcChannels.secretGet]: async (rawKey) => {
      const key = SecretKeySchema.parse(rawKey)
      return ctx.secrets.get(key)
    },

    [IpcChannels.secretDelete]: async (rawKey) => {
      const key = SecretKeySchema.parse(rawKey)
      const ok = ctx.secrets.delete(key)
      ctx.log.info({ key, ok }, 'secret deleted')
      return ok
    },

    [IpcChannels.updatesGetState]: async (): Promise<UpdateState> => ctx.updater.getState(),
    [IpcChannels.updatesCheck]: async (): Promise<UpdateState> => ctx.updater.check(),
    [IpcChannels.updatesInstall]: async (): Promise<UpdateState> => ctx.updater.install(),
    [IpcChannels.openLogsFolder]: async (): Promise<boolean> => {
      const result = await shell.openPath(ctx.logsDir)
      if (result) ctx.log.warn({ err: result }, 'openLogsFolder failed')
      return !result
    }
  }

  ipcMain.handle(IpcChannels.appGetState, () => handlers[IpcChannels.appGetState]())
  ipcMain.handle(IpcChannels.appSetMode, (_e, mode: unknown) => {
    const parsed = AppModeSchema.safeParse(mode)
    if (!parsed.success) throw badRequest('invalid mode')
    return handlers[IpcChannels.appSetMode](parsed.data)
  })
  ipcMain.handle(IpcChannels.settingsUpdate, (_e, patch: unknown) => {
    const parsed = AppSettingsPatchSchema.safeParse(patch)
    if (!parsed.success) throw badRequest('invalid settings patch')
    return handlers[IpcChannels.settingsUpdate](parsed.data)
  })
  ipcMain.handle(IpcChannels.secretSet, (_e, key: unknown, value: unknown) => {
    const k = SecretKeySchema.safeParse(key)
    const v = SecretValueSchema.safeParse(value)
    if (!k.success || !v.success) throw badRequest('invalid secret arguments')
    return handlers[IpcChannels.secretSet](k.data, v.data)
  })
  ipcMain.handle(IpcChannels.secretGet, (_e, key: unknown) => {
    const k = SecretKeySchema.safeParse(key)
    if (!k.success) throw badRequest('invalid secret key')
    return handlers[IpcChannels.secretGet](k.data)
  })
  ipcMain.handle(IpcChannels.secretDelete, (_e, key: unknown) => {
    const k = SecretKeySchema.safeParse(key)
    if (!k.success) throw badRequest('invalid secret key')
    return handlers[IpcChannels.secretDelete](k.data)
  })
  ipcMain.handle(IpcChannels.updatesGetState, () => handlers[IpcChannels.updatesGetState]())
  ipcMain.handle(IpcChannels.updatesCheck, () => handlers[IpcChannels.updatesCheck]())
  ipcMain.handle(IpcChannels.updatesInstall, () => handlers[IpcChannels.updatesInstall]())
  ipcMain.handle(IpcChannels.openLogsFolder, () => handlers[IpcChannels.openLogsFolder]())
}
