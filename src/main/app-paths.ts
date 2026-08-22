import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface AppPaths {
  /** Per-user roaming data root (Electron userData). */
  userDataDir: string
  logsDir: string
  /** Default root for downloads/packaging output when the user picks none. */
  dataDir: string
  settingsFile: string
  secretsFile: string
}

let paths: AppPaths | null = null

/** Must be called after app is ready. */
export function initAppPaths(): AppPaths {
  if (paths) return paths
  const userDataDir = app.getPath('userData')
  paths = {
    userDataDir,
    logsDir: join(userDataDir, 'logs'),
    dataDir: join(userDataDir, 'data'),
    settingsFile: join(userDataDir, 'settings.json'),
    secretsFile: join(userDataDir, 'secrets.json')
  }
  mkdirSync(paths.logsDir, { recursive: true })
  mkdirSync(paths.dataDir, { recursive: true })
  return paths
}

export function getAppPaths(): AppPaths {
  if (!paths) throw new Error('App paths not initialized; call initAppPaths() after app ready')
  return paths
}
