import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { AppSettingsSchema, DEFAULT_SETTINGS, type AppSettings } from '@shared/settings'
import type { Logger } from 'pino'

/**
 * Minimal JSON file store with atomic-ish writes (write temp + rename).
 * Deliberately boring: no watchers, no schema migrations beyond zod defaults.
 */
export class JsonStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly parse: (raw: unknown) => T,
    private readonly fallback: () => T,
    private readonly log?: Logger
  ) {}

  load(): T {
    try {
      if (!existsSync(this.filePath)) return this.fallback()
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf-8'))
      return this.parse(raw)
    } catch (err) {
      this.log?.warn({ err, file: this.filePath }, 'failed to load store; using defaults')
      return this.fallback()
    }
  }

  save(value: T): void {
    try {
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
      renameSync(tmp, this.filePath)
    } catch (err) {
      this.log?.error({ err, file: this.filePath }, 'failed to persist store')
    }
  }
}

export function loadSettings(filePath: string, log?: Logger): AppSettings {
  const store = new JsonStore<AppSettings>(
    filePath,
    (raw) => AppSettingsSchema.parse(raw),
    () => DEFAULT_SETTINGS,
    log
  )
  return store.load()
}

export function saveSettings(filePath: string, settings: AppSettings, log?: Logger): void {
  new JsonStore<AppSettings>(
    filePath,
    (raw) => AppSettingsSchema.parse(raw),
    () => DEFAULT_SETTINGS,
    log
  ).save(settings)
}
