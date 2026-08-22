import { z } from 'zod'
import { AppModeSchema } from './domain'

/**
 * Foundation-level settings owned by the shell. Domain agents (qBittorrent,
 * storage, relay) should extend this schema rather than inventing parallel
 * config stores.
 */
export const AppSettingsSchema = z.object({
  /** Persisted UI mode; null until the user picks one on first launch. */
  mode: AppModeSchema.nullable(),
  /** Port the Fastify relay listens on in server mode. Canonical default 47821. */
  serverPort: z.number().int().min(1).max(65535),
  /** Base URL of the local qBittorrent WebUI (server PC only). */
  qbittorrentBaseUrl: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('http://') || v.startsWith('https://'), {
      message: 'must be an http(s) URL'
    }),
  /** Root directory for downloads and packaging output; null = default under userData. */
  dataDir: z.string().min(1).nullable(),
  /**
   * Pinned Radmin interface ADDRESS (the bind target). null = automatic
   * selection among safe detected candidates; ambiguous adapters require an
   * explicit choice from the server UI.
   */
  radminInterfaceId: z.string().min(1).nullable().default(null),
  /** Launch this app when the user logs into Windows (Electron login item). */
  startWithWindows: z.boolean().default(false),
  /** Block system sleep while a transfer is active (powerSaveBlocker). */
  preventSleepDuringTransfers: z.boolean().default(true),
  /**
   * Client Mode: saved Server PC Radmin IPv4 + relay port. Non-secret
   * settings; the bearer token lives only in the safeStorage secret store.
   */
  clientServerHost: z.string().min(1).nullable().default(null),
  clientServerPort: z.number().int().min(1).max(65535).default(47821)
})
export type AppSettings = z.infer<typeof AppSettingsSchema>

export const AppSettingsPatchSchema = z.object({
  mode: AppModeSchema.nullable().optional(),
  serverPort: z.number().int().min(1).max(65535).optional(),
  qbittorrentBaseUrl: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('http://') || v.startsWith('https://'), {
      message: 'must be an http(s) URL'
    })
    .optional(),
  dataDir: z.string().min(1).nullable().optional(),
  radminInterfaceId: z.string().min(1).nullable().optional(),
  startWithWindows: z.boolean().optional(),
  preventSleepDuringTransfers: z.boolean().optional(),
  clientServerHost: z.string().min(1).nullable().optional(),
  clientServerPort: z.number().int().min(1).max(65535).optional()
})
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>

export const DEFAULT_SETTINGS: AppSettings = {
  mode: null,
  serverPort: 47821,
  qbittorrentBaseUrl: 'http://127.0.0.1:8080',
  dataDir: null,
  radminInterfaceId: null,
  startWithWindows: false,
  preventSleepDuringTransfers: true,
  clientServerHost: null,
  clientServerPort: 47821
}
