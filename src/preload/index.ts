import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type { AppMode } from '@shared/domain'
import type { AppSettingsPatch } from '@shared/settings'
import { IpcChannels } from '@shared/ipc'
import type { VikingRelayBridge } from '@shared/ipc'
import { ClientIpc } from '../main/client-relay/ipc-channels'
import { ServerEvents, ServerIpc } from '../main/server/ipc-channels'

// ---------------------------------------------------------------------------
// Shell bridge (A1) — window.vikingRelay
// ---------------------------------------------------------------------------

const bridge: VikingRelayBridge = {
  getState: () => ipcRenderer.invoke(IpcChannels.appGetState),
  setMode: (mode: AppMode) => ipcRenderer.invoke(IpcChannels.appSetMode, mode),
  updateSettings: (patch: AppSettingsPatch) =>
    ipcRenderer.invoke(IpcChannels.settingsUpdate, patch),
  secrets: {
    set: (key: string, value: string) => ipcRenderer.invoke(IpcChannels.secretSet, key, value),
    get: (key: string) => ipcRenderer.invoke(IpcChannels.secretGet, key),
    remove: (key: string) => ipcRenderer.invoke(IpcChannels.secretDelete, key)
  },
  getUpdateState: () => ipcRenderer.invoke(IpcChannels.updatesGetState),
  checkForUpdates: () => ipcRenderer.invoke(IpcChannels.updatesCheck),
  installUpdate: () => ipcRenderer.invoke(IpcChannels.updatesInstall),
  openLogsFolder: () => ipcRenderer.invoke(IpcChannels.openLogsFolder),
  onLog: (cb: (entry: { level: 'warn' | 'error' | 'info'; msg: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: { level: 'warn' | 'error' | 'info'; msg: string }): void =>
      cb(entry)
    ipcRenderer.on('app:log', listener)
    return () => ipcRenderer.removeListener('app:log', listener)
  }
}

contextBridge.exposeInMainWorld('vikingRelay', bridge)

// ---------------------------------------------------------------------------
// Client Mode bridge (A7 seam) — window.vikingClientBridge
//
// The bearer token lives ONLY in the main process (safeStorage); this surface
// passes pairing values through and returns plain JSON results. No raw IPC,
// no arbitrary fetch, no fs.
// ---------------------------------------------------------------------------

const clientBridge = {
  getConnection: () => ipcRenderer.invoke(ClientIpc.getConnection),
  pair: (params: { host: string; port: number; code: string }) =>
    ipcRenderer.invoke(ClientIpc.pair, params.host, params.port, params.code),
  forgetConnection: () => ipcRenderer.invoke(ClientIpc.forgetConnection),

  connectionStatus: () => ipcRenderer.invoke(ClientIpc.connectionStatus),
  onConnectionChanged: (cb: (status: unknown) => void): (() => void) => {
    // Connection state is derived by main; the renderer's poll covers changes.
    // Push events are not needed for correctness — expose a no-op unsubscribe
    // contract so the A7 seam stays unchanged.
    void cb
    return () => undefined
  },

  createIntake: (input: string) => ipcRenderer.invoke(ClientIpc.createIntake, input),
  getDraft: (jobId: string) => ipcRenderer.invoke(ClientIpc.getDraft, jobId),
  cancelJob: (jobId: string) => ipcRenderer.invoke(ClientIpc.cancelJob, jobId),

  confirmSelection: (jobId: string, fileIndexes: number[], cleanup?: { deleteTorrent?: boolean; deleteFiles?: boolean; deleteZip?: boolean }) =>
    ipcRenderer.invoke(ClientIpc.confirmSelection, jobId, fileIndexes, cleanup),
  startJob: (jobId: string) => ipcRenderer.invoke(ClientIpc.startJob, jobId),
  getJob: (jobId: string) => ipcRenderer.invoke(ClientIpc.getJob, jobId),
  retryPackaging: (jobId: string) => ipcRenderer.invoke(ClientIpc.retryPackaging, jobId),
  retryUpload: (jobId: string) => ipcRenderer.invoke(ClientIpc.retryUpload, jobId),
  retryStorageCheck: (jobId: string) =>
    ipcRenderer.invoke(ClientIpc.retryStorageCheck, jobId),

  listHistory: () => ipcRenderer.invoke(ClientIpc.listHistory),

  copyText: async (text: string): Promise<boolean> => {
    try {
      clipboard.writeText(String(text))
      return true
    } catch {
      return false
    }
  }
}

contextBridge.exposeInMainWorld('vikingClientBridge', clientBridge)

// ---------------------------------------------------------------------------
// Server Mode bridge (A8 seam) — window.vikingRelayServer
// ---------------------------------------------------------------------------

const subscribe = (
  type: 'health' | 'job' | 'pairing',
  cb: (payload: unknown) => void,
): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, message: { type: string; payload: unknown }): void => {
    if (message?.type === type) cb(message.payload)
  }
  ipcRenderer.on(ServerEvents.channel, listener)
  return () => ipcRenderer.removeListener(ServerEvents.channel, listener)
}

const serverBridge = {
  getWorkingFolderStatus: () => ipcRenderer.invoke(ServerIpc.getWorkingFolderStatus),
  setWorkingFolderPath: (path: string) =>
    ipcRenderer.invoke(ServerIpc.setWorkingFolderPath, path),
  chooseWorkingFolder: () => ipcRenderer.invoke(ServerIpc.chooseWorkingFolder),
  getRadminStatus: () => ipcRenderer.invoke(ServerIpc.getRadminStatus),
  selectRadminInterface: (id: string) =>
    ipcRenderer.invoke(ServerIpc.selectRadminInterface, id),
  probeQbittorrent: (config: { webUiUrl: string; apiKey?: string }) =>
    ipcRenderer.invoke(ServerIpc.probeQbittorrent, config),
  getVikingConfig: () => ipcRenderer.invoke(ServerIpc.getVikingConfig),
  setVikingUserHash: (hash: string) => ipcRenderer.invoke(ServerIpc.setVikingUserHash, hash),

  startServer: () => ipcRenderer.invoke(ServerIpc.startServer),
  stopServer: () => ipcRenderer.invoke(ServerIpc.stopServer),
  getHealth: () => ipcRenderer.invoke(ServerIpc.getHealth),

  generatePairingCode: () => ipcRenderer.invoke(ServerIpc.generatePairingCode),
  listPairedClients: () => ipcRenderer.invoke(ServerIpc.listPairedClients),
  revokePairedClient: (clientId: string) =>
    ipcRenderer.invoke(ServerIpc.revokePairedClient, clientId),
  resetProfile: () => ipcRenderer.invoke(ServerIpc.resetProfile),

  getActiveJob: () => ipcRenderer.invoke(ServerIpc.getActiveJob),
  getHistory: (limit: number) => ipcRenderer.invoke(ServerIpc.getHistory, limit),
  getArchivedHistory: (limit: number) => ipcRenderer.invoke(ServerIpc.getArchivedHistory, limit),
  setJobArchived: (jobId: string, archived: boolean) =>
    ipcRenderer.invoke(ServerIpc.setJobArchived, jobId, archived),
  copyText: (text: string) => ipcRenderer.invoke(ServerIpc.copyText, text),
  dismissInterruptedJob: (jobId: string) =>
    ipcRenderer.invoke(ServerIpc.dismissInterruptedJob, jobId),
  cleanJobData: (jobId: string) => ipcRenderer.invoke(ServerIpc.cleanJobData, jobId),
  openQBittorrentWebUi: () => ipcRenderer.invoke(ServerIpc.openQBittorrentWebUi),

  getSettings: () => ipcRenderer.invoke(ServerIpc.getSettings),
  updateSettings: (patch: unknown) => ipcRenderer.invoke(ServerIpc.updateSettings, patch),
  setQbitApiKey: (apiKey: string) => ipcRenderer.invoke(ServerIpc.setQbitApiKey, apiKey),

  capabilities: () => ipcRenderer.invoke(ServerIpc.capabilities),
  requestAppExit: () => ipcRenderer.invoke(ServerIpc.requestAppExit),

  onHealth: (cb: (snapshot: unknown) => void) => subscribe('health', cb),
  onJob: (cb: (job: unknown) => void) => subscribe('job', cb),
  onPairing: (cb: (pairing: unknown) => void) => subscribe('pairing', cb)
}

contextBridge.exposeInMainWorld('vikingRelayServer', serverBridge)
