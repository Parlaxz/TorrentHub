import pino from 'pino'
import type { Logger } from 'pino'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'

let logger: Logger | null = null

export function initLogger(logsDir: string, isDev: boolean): Logger {
  if (logger) return logger
  const logFile = join(logsDir, `viking-relay-${new Date().toISOString().slice(0, 10)}.log`)
  const streams: pino.StreamEntry[] = [{ stream: createWriteStream(logFile, { flags: 'a' }) }]
  if (isDev) streams.push({ stream: process.stdout })
  logger = pino(
    { level: isDev ? 'debug' : 'info', timestamp: pino.stdTimeFunctions.isoTime },
    pino.multistream(streams)
  )
  return logger
}

export function getLogger(): Logger {
  if (!logger) throw new Error('Logger not initialized; call initLogger() first')
  return logger
}
