import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import type { Logger } from 'pino'

interface SecretFileShape {
  version: 1
  entries: Record<string, string>
}

const EMPTY: SecretFileShape = { version: 1, entries: {} }

/**
 * Mediated secret storage backed by Electron safeStorage (DPAPI on Windows).
 * Values are encrypted to hex and kept in a single local file. Nothing here is
 * exposed to the renderer except through the narrow IPC handlers.
 */
export class SecretStore {
  constructor(
    private readonly filePath: string,
    private readonly log: Logger
  ) {}

  private readAll(): SecretFileShape {
    try {
      if (!existsSync(this.filePath)) return EMPTY
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as SecretFileShape
      if (raw.version !== 1 || typeof raw.entries !== 'object' || raw.entries === null) return EMPTY
      return raw
    } catch (err) {
      this.log.warn({ err }, 'secrets file unreadable; starting empty')
      return EMPTY
    }
  }

  private writeAll(file: SecretFileShape): void {
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8')
    renameSync(tmp, this.filePath)
  }

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  set(key: string, value: string): boolean {
    if (!this.isAvailable()) {
      this.log.error('safeStorage unavailable; refusing to store secret in plaintext')
      return false
    }
    const file = this.readAll()
    file.entries[key] = safeStorage.encryptString(value).toString('hex')
    this.writeAll(file)
    return true
  }

  get(key: string): string | null {
    const file = this.readAll()
    const hex = file.entries[key]
    if (!hex) return null
    try {
      return safeStorage.decryptString(Buffer.from(hex, 'hex'))
    } catch (err) {
      this.log.warn({ err, key }, 'failed to decrypt secret')
      return null
    }
  }

  delete(key: string): boolean {
    const file = this.readAll()
    if (!(key in file.entries)) return false
    delete file.entries[key]
    this.writeAll(file)
    return true
  }
}
