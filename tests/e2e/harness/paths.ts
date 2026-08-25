import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import os from 'node:os'

/** Process-lifetime artifact root for this E2E run. */
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-')

/** Keep this many most-recent artifact run dirs; older ones are pruned. */
const ARTIFACT_KEEP = 5

export function artifactRoot(): string {
  const root = join(process.cwd(), 'artifacts', 'e2e', RUN_STAMP)
  mkdirSync(root, { recursive: true })
  pruneOldArtifactRuns()
  pruneStaleTempUserData()
  return root
}

/** Storage hygiene: keep only the newest artifact run dirs. */
function pruneOldArtifactRuns(): void {
  try {
    const base = join(process.cwd(), 'artifacts', 'e2e')
    const runs = readdirSync(base)
      .filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n))
      .map((n) => ({ n, t: statSync(join(base, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const old of runs.slice(ARTIFACT_KEEP)) {
      rmSync(join(base, old.n), { recursive: true, force: true })
    }
  } catch {
    /* best effort */
  }
}

/**
 * Storage hygiene: temp userData dirs from crashed runs accumulate
 * (~1-3 MB each). Delete anything older than 60 min — active runs hold
 * recent dirs only.
 */
function pruneStaleTempUserData(): void {
  try {
    const base = join(tmpdir(), 'viking-relay-e2e')
    const cutoff = Date.now() - 60 * 60_000
    for (const dir of readdirSync(base)) {
      const full = join(base, dir)
      if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true })
    }
  } catch {
    /* best effort */
  }
}

/** Unique per-instance userData dir (isolates ALL app persistence). */
export function makeTempUserData(label: string): string {
  const base = join(tmpdir(), 'viking-relay-e2e')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, `${label}-`))
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))))
    })
    srv.on('error', reject)
  })
}

/**
 * First non-internal IPv4 address of this machine — usable as a relay bind
 * target (the relay refuses 0.0.0.0 and prefers Radmin-named adapters; an
 * explicit pin to the LAN address works for same-machine two-instance E2E).
 */
export function lanetAddress(): string | null {
  const ifaces = os.networkInterfaces()
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (/radmin|famatech/i.test(name)) continue // prefer NOT to touch real VPN adapters
    for (const addr of addrs ?? []) {
      if (
        !addr.internal &&
        addr.family === 'IPv4' &&
        /^\d+\.\d+\.\d+\.\d+$/.test(addr.address) &&
        addr.address !== '0.0.0.0'
      ) {
        return addr.address
      }
    }
  }
  // Fall back to a Radmin adapter if that is all we have.
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (!addr.internal && addr.family === 'IPv4' && addr.address !== '0.0.0.0') return addr.address
    }
  }
  return null
}
