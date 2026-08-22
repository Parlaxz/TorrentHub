import type { AppSettings, AppSettingsPatch } from '@shared/settings'
import { loadSettings, saveSettings } from './store'

/**
 * In-memory holder for validated app settings with persistence on change.
 * Single-writer (main process only).
 */
export class AppSettingsStore {
  private current: AppSettings

  constructor(
    private readonly filePath: string,
    private readonly log?: import('pino').Logger
  ) {
    this.current = loadSettings(filePath, log)
  }

  get(): AppSettings {
    return this.current
  }

  update(patch: AppSettingsPatch): AppSettings {
    this.current = { ...this.current, ...patch }
    saveSettings(this.filePath, this.current, this.log)
    return this.current
  }
}
