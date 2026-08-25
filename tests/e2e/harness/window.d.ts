import type { AppSettings } from '../../../src/shared/settings'

/** Minimal structural typing for the app's preload bridges inside E2E specs. */
declare global {
  interface Window {
    vikingRelay: {
      getState(): Promise<{ mode: 'client' | 'server' | null; settings: AppSettings; versions: { app: string; electron: string; chrome: string; node: string } }>
      setMode(mode: 'client' | 'server'): Promise<unknown>
      updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
      secrets: {
        set(key: string, value: string): Promise<boolean>
        get(key: string): Promise<string | null>
        remove(key: string): Promise<boolean>
      }
      getUpdateState(): Promise<{ phase: string; currentVersion: string; availableVersion: string | null; progressPct: number | null; error: string | null; disabled: boolean }>
      checkForUpdates(): Promise<unknown>
      openLogsFolder(): Promise<boolean>
      getDirectDownloadsState(): Promise<{
        settings: { autoAccept: boolean; qbitUrl: string; qbitKeySet: boolean; downloadDir: string | null }
        queue: Array<{ id: string; source: string; sourceKind: string; state: string; error?: string | null }>
      }>
      setDirectDownloadSettings(patch: { autoAccept?: boolean; qbitUrl?: string; qbitKey?: string; downloadDir?: string | null }): Promise<void>
      acceptDirectDownload(id: string): Promise<void>
      declineDirectDownload(id: string): Promise<void>
      refreshDirectDownloads(): Promise<void>
    }
    vikingClientBridge: {
      getConnection(): Promise<unknown>
      pair(params: { host: string; port: number; code: string }): Promise<unknown>
      forgetConnection(): Promise<unknown>
      connectionStatus(): Promise<unknown>
      createIntake(input: string): Promise<{ jobId: string } | unknown>
      getDraft(jobId: string): Promise<unknown>
      cancelJob(jobId: string): Promise<unknown>
      confirmSelection(jobId: string, fileIndexes: number[], cleanup?: { deleteTorrent?: boolean; deleteFiles?: boolean; deleteZip?: boolean }): Promise<unknown>
      startJob(jobId: string): Promise<unknown>
      getJob(jobId: string): Promise<unknown>
      retryPackaging(jobId: string): Promise<unknown>
      retryUpload(jobId: string): Promise<unknown>
      listHistory(): Promise<Array<Record<string, unknown>>>
      clientsList(): Promise<Array<Record<string, unknown>>>
      sendToFriend(source: string, targetClientId: string): Promise<unknown>
      friendsGet(): Promise<Array<{ clientId: string; name: string }>>
      friendsAdd(friend: { clientId: string; name: string }): Promise<unknown>
      friendsRemove(clientId: string): Promise<unknown>
      copyText(text: string): Promise<boolean>
    }
    vikingRelayServer: Record<string, (...args: unknown[]) => Promise<unknown>> & {
      getHealth(): Promise<Record<string, unknown>>
      generatePairingCode(): Promise<{ code: string; expiresAt?: string } & Record<string, unknown>>
      listPairedClients(): Promise<Array<Record<string, unknown>>>
      revokePairedClient(clientId: string): Promise<unknown>
      sendDirectJob(source: string, targetClientId: string): Promise<unknown>
      listDirectJobs(): Promise<Array<Record<string, unknown>>>
      resetProfile(): Promise<unknown>
      getActiveJob(): Promise<unknown>
      getHistory(limit: number): Promise<Array<Record<string, unknown>>>
      getArchivedHistory(limit: number): Promise<Array<Record<string, unknown>>>
      setJobArchived(jobId: string, archived: boolean): Promise<unknown>
      dismissInterruptedJob(jobId: string): Promise<unknown>
      cleanJobData(jobId: string): Promise<unknown>
      getSettings(): Promise<Record<string, unknown>>
      updateSettings(patch: Record<string, unknown>): Promise<unknown>
      setQbitApiKey(apiKey: string): Promise<unknown>
      capabilities(): Promise<Record<string, unknown>>
      requestAppExit(): Promise<unknown>
      startServer(): Promise<Record<string, unknown>>
      stopServer(): Promise<unknown>
      probeQbittorrent(config: { webUiUrl: string; apiKey?: string }): Promise<Record<string, unknown>>
      getWorkingFolderStatus(): Promise<Record<string, unknown>>
      setWorkingFolderPath(path: string): Promise<unknown>
      getRadminStatus(): Promise<Record<string, unknown>>
      selectRadminInterface(id: string): Promise<unknown>
      getVikingConfig(): Promise<Record<string, unknown>>
      setVikingUserHash(hash: string): Promise<unknown>
    }
  }
}

export {}
