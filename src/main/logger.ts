import pino from 'pino'
import type { Logger } from 'pino'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

let logger: Logger | null = null

type LogSink = (entry: { level: string; msg: string }) => void
const sinks = new Set<LogSink>()

/** Forwards log entries to attached windows so errors reach the DevTools console. */
const mirrorStream = {
  level: 'warn' as const,
  write(chunk: string): void {
    let entry: { level: number; msg: string }
    try {
      entry = JSON.parse(chunk)
    } catch {
      return
    }
    const level = entry.level >= 50 ? 'error' : entry.level >= 40 ? 'warn' : 'info'
    const payload = { level, msg: entry.msg ?? '' }
    for (const sink of sinks) {
      try {
        sink(payload)
      } catch {
        /* window went away */
      }
    }
  },
}

export function addLogSink(sink: LogSink): () => void {
  sinks.add(sink)
  return () => sinks.delete(sink)
}

export function attachWindowLogMirror(getWindows: () => BrowserWindow[]): void {
  addLogSink(({ level, msg }) => {
    for (const win of getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('app:log', { level, msg })
      }
    }
  })
}

export function initLogger(logsDir: string, isDev: boolean): Logger {
  if (logger) return logger
  const logFile = join(logsDir, `viking-relay-${new Date().toISOString().slice(0, 10)}.log`)
  // stdout is ALWAYS attached: launching the exe from a terminal shows every
  // line, which beats a silent packaged app when hunting failures.
  const streams: pino.StreamEntry[] = [
    { stream: createWriteStream(logFile, { flags: 'a' }) },
    { stream: process.stdout },
    { stream: mirrorStream },
  ]
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
