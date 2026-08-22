import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/** Deterministic patterned buffer so byte-range assertions are exact. */
export function patternedBuffer(size: number): Buffer {
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i += 1) buf[i] = i % 251
  return buf
}

export interface TempFile {
  path: string
  size: number
  content: Buffer
  mtimeMs: number
}

export async function writeTempFile(name: string, content: Buffer): Promise<TempFile> {
  const dir = path.join(os.tmpdir(), 'opencode', 'viking-tests')
  await fs.promises.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${name}-${crypto.randomBytes(4).toString('hex')}.bin`)
  await fs.promises.writeFile(filePath, content)
  const stat = await fs.promises.stat(filePath)
  return { path: filePath, size: content.length, content, mtimeMs: stat.mtimeMs }
}

export async function fileUnchanged(file: TempFile): Promise<boolean> {
  const stat = await fs.promises.stat(file.path)
  const current = await fs.promises.readFile(file.path)
  return stat.mtimeMs === file.mtimeMs && current.equals(file.content)
}

export async function cleanupTempFiles(files: Array<{ path: string }>): Promise<void> {
  await Promise.all(
    files.map((f) => fs.promises.rm(f.path, { force: true }).catch(() => undefined)),
  )
}
