import { ipcMain, shell } from 'electron'
import type { AppState, IpcHandlers, UpdateState } from '@shared/ipc'
import { AppModeSchema, IpcChannels, SecretKeySchema, SecretValueSchema } from '@shared/ipc'
import { AppSettingsPatchSchema } from '@shared/settings'
import type { Logger } from 'pino'
import type { SecretStore } from './secrets'
import type { AppSettingsStore } from './settings-store'
import type { AppUpdater } from './updater'
import type { DirectDownloadsService } from './client-relay/direct-downloads'

interface IpcContext {
  store: AppSettingsStore
  secrets: SecretStore
  log: Logger
  versions: AppState['versions']
  updater: AppUpdater
  logsDir: string
  directDownloads: DirectDownloadsService
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
    },
    [IpcChannels.ddGetState]: async () => ({
      settings: ctx.directDownloads.getSettings(),
      queue: await ctx.directDownloads.listLocal(),
    }),
    [IpcChannels.ddSetSettings]: async (rawPatch) => {
      const patch = (rawPatch ?? {}) as Parameters<DirectDownloadsService['setSettings']>[0]
      await ctx.directDownloads.setSettings(patch)
      void ctx.directDownloads.pollOnce().catch(() => {})
    },
    [IpcChannels.ddAccept]: async (rawId) => {
      await ctx.directDownloads.accept(String(rawId))
    },
    [IpcChannels.ddDecline]: async (rawId) => {
      await ctx.directDownloads.decline(String(rawId))
    },
    [IpcChannels.ddRefresh]: async () => {
      await ctx.directDownloads.pollOnce()
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
  ipcMain.handle(IpcChannels.ddGetState, () => handlers[IpcChannels.ddGetState]())
  ipcMain.handle(IpcChannels.ddSetSettings, (_e, patch: unknown) => {
    const p = (patch ?? {}) as Record<string, unknown>
    const clean: { autoAccept?: boolean; qbitUrl?: string; qbitKey?: string; downloadDir?: string | null } = {}
    if (typeof p.autoAccept === 'boolean') clean.autoAccept = p.autoAccept
    if (typeof p.qbitUrl === 'string' && /^https?:\/\//i.test(p.qbitUrl)) clean.qbitUrl = p.qbitUrl
    if (typeof p.qbitKey === 'string' && p.qbitKey.trim().length > 0) clean.qbitKey = p.qbitKey
    if (p.downloadDir === null || typeof p.downloadDir === 'string') {
      clean.downloadDir = typeof p.downloadDir === 'string' && p.downloadDir.trim() ? p.downloadDir.trim() : null
    }
    return handlers[IpcChannels.ddSetSettings](clean)
  })
  ipcMain.handle(IpcChannels.ddAccept, (_e, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw badRequest('invalid id')
    return handlers[IpcChannels.ddAccept](id)
  })
  ipcMain.handle(IpcChannels.ddDecline, (_e, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw badRequest('invalid id')
    return handlers[IpcChannels.ddDecline](id)
  })
  ipcMain.handle(IpcChannels.ddRefresh, () => handlers[IpcChannels.ddRefresh]())
}
