/**
 * IPC registration for the Server Mode bridge (`window.vikingRelayServer`)
 * and the Client Mode bridge (`window.vikingClientBridge`).
 *
 * Every channel is a narrow, validated surface: no raw ipcRenderer, no
 * arbitrary fetch, no fs/shell access leaks through to the renderer.
 */
import { BrowserWindow, clipboard, ipcMain } from 'electron'

import { getLogger } from '../logger'
import type { ServerController } from './controller'
import type { ClientRelayService } from '../client-relay/service'
import { ClientIpc } from '../client-relay/ipc-channels'
import { ServerEvents, ServerIpc } from './ipc-channels'

/**
 * Wraps a handler so failures are logged (file + console) before the
 * rejection reaches the renderer. Without this, packaged-app IPC errors
 * vanish silently and leave an empty console to debug against.
 */
function makeHandle(): (channel: string, fn: (...args: never[]) => unknown) => void {
  return (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return await (fn as (...a: unknown[]) => unknown)(...args)
      } catch (error) {
        try {
          getLogger().error({ err: error, channel }, 'IPC handler failed')
        } catch {
          /* logger not initialized yet */
        }
        console.error(`[ipc:${channel}]`, error)
        throw error
      }
    })
  }
}

export function registerServerBridgeIpc(controller: ServerController): void {
  const handle = makeHandle()

  handle(ServerIpc.getWorkingFolderStatus, () => controller.getWorkingFolderStatus())
  handle(ServerIpc.setWorkingFolderPath, (p: unknown) =>
    controller.setWorkingFolderPath(String(p)),
  )
  handle(ServerIpc.chooseWorkingFolder, () => controller.chooseWorkingFolder())
  handle(ServerIpc.getRadminStatus, () => controller.getRadminStatus())
  handle(ServerIpc.selectRadminInterface, (id: unknown) =>
    controller.selectRadminInterface(String(id)),
  )
  handle(ServerIpc.probeQbittorrent, (config: unknown) => {
    const c = (config ?? {}) as { webUiUrl?: unknown; apiKey?: unknown }
    return controller.probeQbittorrent({
      webUiUrl: String(c.webUiUrl ?? ''),
      apiKey: typeof c.apiKey === 'string' && c.apiKey.length > 0 ? c.apiKey : undefined,
    })
  })
  handle(ServerIpc.getVikingConfig, () => controller.getVikingConfig())
  handle(ServerIpc.setVikingUserHash, (hash: unknown) =>
    controller.setVikingUserHash(String(hash ?? '')),
  )
  handle(ServerIpc.startServer, () => controller.startServer())
  handle(ServerIpc.stopServer, () => controller.stopServer())
  handle(ServerIpc.getHealth, () => controller.getHealth())
  handle(ServerIpc.generatePairingCode, () => controller.generatePairingCode())
  handle(ServerIpc.listPairedClients, () => controller.listPairedClients())
  handle(ServerIpc.revokePairedClient, (clientId: unknown) =>
    controller.revokePairedClient(String(clientId ?? '')),
  )
  handle(ServerIpc.resetProfile, () => controller.resetProfile())
  handle(ServerIpc.getActiveJob, () => controller.getActiveJob())
  handle(ServerIpc.getHistory, (limit: unknown) => controller.getHistory(Number(limit) || 20))
  handle(ServerIpc.getArchivedHistory, (limit: unknown) =>
    controller.getHistory(Number(limit) || 50, true),
  )
  handle(ServerIpc.setJobArchived, (jobId: unknown, archived: unknown) =>
    controller.setJobArchived(String(jobId ?? ''), Boolean(archived)),
  )
  handle(ServerIpc.copyText, (text: unknown) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })
  handle(ServerIpc.dismissInterruptedJob, (jobId: unknown) =>
    controller.dismissInterruptedJob(String(jobId)),
  )
  handle(ServerIpc.cleanJobData, (jobId: unknown) => controller.cleanJobData(String(jobId)))
  handle(ServerIpc.openQBittorrentWebUi, () => controller.openQBittorrentWebUi())
  handle(ServerIpc.getSettings, () => controller.getSettings())
  handle(ServerIpc.updateSettings, (patch: unknown) =>
    controller.updateSettings(patch as Parameters<ServerController['updateSettings']>[0]),
  )
  handle(ServerIpc.setQbitApiKey, (apiKey: unknown) => controller.setQbitApiKey(String(apiKey ?? '')))
  handle(ServerIpc.capabilities, () => controller.capabilities())
  handle(ServerIpc.requestAppExit, () => controller.requestAppExit())

  // Event push: health/job ~1/s while running; pairing on demand.
  controller.onHealth((snapshot) => {
    for (const win of allWindows()) {
      win.webContents.send(ServerEvents.channel, { type: 'health', payload: snapshot })
    }
  })
  controller.onJob((job) => {
    for (const win of allWindows()) {
      win.webContents.send(ServerEvents.channel, { type: 'job', payload: job })
    }
  })
  controller.onPairing((pairing) => {
    for (const win of allWindows()) {
      win.webContents.send(ServerEvents.channel, { type: 'pairing', payload: pairing })
    }
  })
}

export function registerClientBridgeIpc(client: ClientRelayService): void {
  const handle = makeHandle()

  handle(ClientIpc.getConnection, () => client.getConnection())
  handle(ClientIpc.pair, (host: unknown, port: unknown, code: unknown) =>
    client.pair(String(host ?? ''), Number(port) || 47821, String(code ?? '')),
  )
  handle(ClientIpc.forgetConnection, () => client.forgetConnection())
  handle(ClientIpc.connectionStatus, () => client.connectionStatus())
  handle(ClientIpc.createIntake, (input: unknown) => client.createIntake(String(input ?? '')))
  handle(ClientIpc.getDraft, (jobId: unknown) => client.getDraft(String(jobId)))
  handle(ClientIpc.cancelJob, (jobId: unknown) => client.cancelJob(String(jobId)))
  handle(ClientIpc.confirmSelection, (jobId: unknown, indexes: unknown, cleanup: unknown) =>
    client.confirmSelection(
      String(jobId),
      Array.isArray(indexes) ? indexes.map((i) => Number(i)) : [],
      typeof cleanup === 'object' && cleanup !== null
        ? (cleanup as { deleteTorrent?: boolean; deleteFiles?: boolean; deleteZip?: boolean })
        : undefined,
    ),
  )
  handle(ClientIpc.startJob, (jobId: unknown) => client.startJob(String(jobId)))
  handle(ClientIpc.getJob, (jobId: unknown) => client.getJob(String(jobId)))
  handle(ClientIpc.retryPackaging, (jobId: unknown) => client.retryPackaging(String(jobId)))
  handle(ClientIpc.retryUpload, (jobId: unknown) => client.retryUpload(String(jobId)))
  handle(ClientIpc.retryStorageCheck, (jobId: unknown) =>
    client.retryStorageCheck(String(jobId)),
  )
  handle(ClientIpc.listHistory, () => client.listHistory())
}

function allWindows(): Electron.BrowserWindow[] {
  return BrowserWindow.getAllWindows()
}
