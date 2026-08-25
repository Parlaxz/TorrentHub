import { _electron, type ElectronApplication, type Page } from 'playwright'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import { artifactRoot, makeTempUserData } from './paths'

const REPO = process.cwd()

/* ------------------------------------------------------------------ */
/* Bridge surface (structural subset of shared/ipc.ts — test-typed)    */

export interface AppStateLike {
  mode: 'client' | 'server' | null
  settings: AppSettings
  versions: { app: string; electron: string; chrome: string; node: string }
}

/* ------------------------------------------------------------------ */
/* Types                                                               */

export interface LaunchOptions {
  /** Permanent test id, e.g. "CORE-001". Used for the artifact dir. */
  testId: string
  /** Instance label for logs ("server", "client-a", ...). */
  label?: string
  /** Settings seeded into settings.json BEFORE launch (full defaults + patch). */
  settings?: Partial<AppSettings>
  /** Extra env for the main process (e.g. VIKING_BASE_URL). */
  env?: Record<string, string>
  /** Launch with --hidden (tray-only). */
  hidden?: boolean
  /**
   * Storage hygiene: userData dirs are deleted on close by default
   * (~1-3 MB each; evidence lives in artifacts). Opt out only when a test
   * reads persisted files AFTER close.
   */
  keepUserDataOnClose?: boolean
  /**
   * Reuse an EXISTING userData dir instead of creating a fresh one — required
   * for true-restart scenarios: Electron safeStorage ciphertext is bound to
   * the userData directory, so secrets cannot be migrated by copying files.
   */
  userDataDir?: string
}

export interface MarkerEntry {
  at: string
  name: string
  payload?: unknown
}

interface ConsoleEntry {
  at: string
  type: string
  text: string
}

interface ResponseEntry {
  at: string
  url: string
  status: number
  method: string
}

/* ------------------------------------------------------------------ */
/* App handle                                                          */

export class AppHandle {
  readonly app: ElectronApplication
  readonly page: Page
  readonly userDataDir: string
  readonly artifactsDir: string
  readonly label: string
  private readonly markers: MarkerEntry[] = []
  private readonly consoleLog: ConsoleEntry[] = []
  private readonly pageErrors: string[] = []
  private readonly failedRequests: ResponseEntry[] = []
  private readonly responses: ResponseEntry[] = []
  private stdoutBuf = ''
  private stderrBuf = ''
  private closed = false
  private readonly keepUserDataOnClose: boolean

  constructor(
    app: ElectronApplication,
    page: Page,
    opts: { userDataDir: string; artifactsDir: string; label: string; keepUserDataOnClose?: boolean }
  ) {
    this.app = app
    this.page = page
    this.userDataDir = opts.userDataDir
    this.artifactsDir = opts.artifactsDir
    this.label = opts.label
    this.keepUserDataOnClose = opts.keepUserDataOnClose ?? false
    this.attachCollectors()
  }

  private attachCollectors(): void {
    this.page.on('console', (msg) => {
      this.consoleLog.push({ at: new Date().toISOString(), type: msg.type(), text: msg.text() })
      if (this.consoleLog.length > 5000) this.consoleLog.shift()
    })
    this.page.on('pageerror', (err) => {
      this.pageErrors.push(`${new Date().toISOString()} ${err.stack ?? err.message}`)
    })
    this.page.on('requestfailed', (req) => {
      const entry: ResponseEntry = {
        at: new Date().toISOString(),
        url: req.url(),
        status: -1,
        method: req.method()
      }
      this.failedRequests.push(entry)
      this.responses.push(entry)
    })
    this.page.on('response', (res) => {
      const entry: ResponseEntry = {
        at: new Date().toISOString(),
        url: res.url(),
        status: res.status(),
        method: res.request().method()
      }
      this.responses.push(entry)
      if (res.status() >= 400) this.failedRequests.push(entry)
      if (this.responses.length > 5000) this.responses.shift()
    })
    const proc = this.app.process()
    proc.stdout?.on('data', (d: Buffer) => {
      this.stdoutBuf += d.toString()
      if (this.stdoutBuf.length > 512_000) this.stdoutBuf = this.stdoutBuf.slice(-256_000)
    })
    proc.stderr?.on('data', (d: Buffer) => {
      this.stderrBuf += d.toString()
      if (this.stderrBuf.length > 512_000) this.stderrBuf = this.stderrBuf.slice(-256_000)
    })
  }

  /* ---------------- markers ---------------- */

  async marker(name: string, payload?: unknown): Promise<void> {
    this.markers.push({ at: new Date().toISOString(), name, payload })
  }

  /** Public read-only accessors for collector state (used by specs + waits). */
  failedRequestCount(): number {
    return this.failedRequests.length
  }

  pageErrorCount(): number {
    return this.pageErrors.length
  }

  mainStdout(): string {
    return this.stdoutBuf
  }

  mainStderr(): string {
    return this.stderrBuf
  }

  /* ---------------- bridge helpers ---------------- */

  async getState(): Promise<AppStateLike> {
    return this.page.evaluate(() => window.vikingRelay.getState())
  }

  async clientBridge<T>(expr: string): Promise<T> {
    const full = expr.startsWith('window.') ? expr : `window.vikingClientBridge.${expr}`
    return this.page.evaluate(
      `(window.vikingClientBridge && (${full})) || Promise.reject(new Error('client bridge unavailable'))`
    ) as Promise<T>
  }

  async serverBridge<T>(expr: string): Promise<T> {
    const full = expr.startsWith('window.') ? expr : `window.vikingRelayServer.${expr}`
    return this.page.evaluate(
      `(window.vikingRelayServer && (${full})) || Promise.reject(new Error('server bridge unavailable'))`
    ) as Promise<T>
  }

  /**
   * Bounded state wait against a page predicate. No arbitrary sleeps.
   * Diagnostics on expiry include current DOM + snapshot summary.
   */
  async waitFor(
    description: string,
    fn: () => Promise<boolean>,
    opts: { timeoutMs?: number; pollMs?: number } = {}
  ): Promise<void> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000)
    const pollMs = opts.pollMs ?? 250
    let lastError: unknown = null
    while (Date.now() < deadline) {
      try {
        if (await fn()) return
      } catch (err) {
        lastError = err
      }
      await this.page.waitForTimeout(pollMs)
    }
    const diag = await this.diagnose()
    throw new Error(
      `Timed out after ${opts.timeoutMs ?? 30_000}ms waiting for: ${description}\n` +
        `last predicate error: ${String(lastError)}\nDIAGNOSTICS:\n${diag}`
    )
  }

  /** Truthful cross-layer snapshot used in failure diagnostics. */
  async diagnose(): Promise<string> {
    const lines: string[] = []
    lines.push(`url=${this.page.url()}`)
    try {
      const state = await this.page.evaluate(() =>
        window.vikingRelay
          ? window.vikingRelay.getState().then((s) => JSON.stringify({ mode: s.mode }))
          : Promise.resolve(JSON.stringify({ mode: 'no-bridge' }))
      )
      lines.push(`state=${state}`)
    } catch (err) {
      lines.push(`state=<unavailable: ${String(err)}>`)
    }
    lines.push(`pageErrors=${this.pageErrors.length} failedRequests=${this.failedRequests.length}`)
    return lines.join('\n')
  }

  screenshot(name: string): Promise<Buffer | null> {
    return this.page.screenshot({ path: join(this.artifactsDir, `${name}.png`), fullPage: true }).catch(() => null)
  }

  /* ---------------- persistence probes ---------------- */

  readPersisted(relativePath: string): string | null {
    const p = join(this.userDataDir, relativePath)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  }

  dataRoot(): string {
    // Server job history lives under settings.dataDir when configured.
    return this.userDataDir
  }

  /* ---------------- teardown ---------------- */

  /** Graceful close → bounded force kill → artifact flush. Idempotent. */
  async close(opts: { forceAfterMs?: number } = {}): Promise<{ exitCode: number | null; forced: boolean }> {
    if (this.closed) return { exitCode: null, forced: false }
    this.closed = true
    await this.marker('app-close')
    const forceAfterMs = opts.forceAfterMs ?? 10_000
    let forced = false
    const proc = this.app.process()
    if (!proc) {
      // App already exited (e.g. clean quit driven inside the test).
      this.flushArtifacts(null, false)
      this.cleanupUserDataDir()
      return { exitCode: null, forced: false }
    }
    const exited = new Promise<number | null>((resolve) => {
      if (proc.exitCode !== null) resolve(proc.exitCode)
      else proc.once('exit', (code) => resolve(code))
    })
    await this.app.close().catch(() => undefined)
    const race = await Promise.race([
      exited.then((code) => ({ code, forced: false })),
      new Promise<{ code: number | null; forced: boolean }>((resolve) =>
        setTimeout(() => resolve({ code: null, forced: true }), forceAfterMs)
      )
    ])
    if (race.forced && proc.exitCode === null) {
      forced = true
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }
    const exitCode = await exited
    this.flushArtifacts(exitCode, forced)
    this.cleanupUserDataDir()
    return { exitCode, forced }
  }

  /** Storage hygiene: evidence lives in artifacts; drop the instance dir.
   * Windows note: child-process handles (GPU/renderer) can linger briefly
   * after main exits — retry with backoff before giving up (the >60 min
   * stale-prune at next launch is the final backstop). */
  private cleanupUserDataDir(): void {
    if (this.keepUserDataOnClose) return
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        rmSync(this.userDataDir, { recursive: true, force: true })
        return
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * (attempt + 1))
      }
    }
  }

  /** Writes console/request/server-log/markers artifacts. Survives the process. */
  flushArtifacts(exitCode: number | null, forced: boolean): void {
    mkdirSync(this.artifactsDir, { recursive: true })
    writeFileSync(join(this.artifactsDir, `console-${this.label}.log`), this.consoleLog.map((c) => `${c.at} [${c.type}] ${c.text}`).join('\n'))
    writeFileSync(join(this.artifactsDir, `page-errors-${this.label}.log`), this.pageErrors.join('\n'))
    writeFileSync(join(this.artifactsDir, `responses-${this.label}.json`), JSON.stringify(this.responses, null, 2))
    writeFileSync(join(this.artifactsDir, `failed-requests-${this.label}.json`), JSON.stringify(this.failedRequests, null, 2))
    writeFileSync(join(this.artifactsDir, `main-stdout-${this.label}.log`), this.stdoutBuf)
    writeFileSync(join(this.artifactsDir, `main-stderr-${this.label}.log`), this.stderrBuf)
    writeFileSync(join(this.artifactsDir, `markers-${this.label}.json`), JSON.stringify(this.markers, null, 2))
    // Copy pino log files from userData/logs (logger writes date-stamped names).
    const logsDir = join(this.userDataDir, 'logs')
    if (existsSync(logsDir)) {
      for (const f of readdirSync(logsDir)) {
        if (!f.startsWith('viking-relay')) continue
        const src = join(logsDir, f)
        try {
          appendFileSync(join(this.artifactsDir, `app-${f}`), readFileSync(src, 'utf8'))
        } catch {
          /* best effort */
        }
      }
    }
    writeFileSync(
      join(this.artifactsDir, `summary-${this.label}.json`),
      JSON.stringify(
        {
          label: this.label,
          exitCode,
          forcedKill: forced,
          userDataDir: this.userDataDir,
          pageErrors: this.pageErrors.length,
          failedRequests: this.failedRequests.length,
          consoleEntries: this.consoleLog.length,
          responses: this.responses.length,
          markers: this.markers.length
        },
        null,
        2
      )
    )
  }
}

/* ------------------------------------------------------------------ */
/* Launcher                                                            */

export function seedSettingsFile(userDataDir: string, overrides: Partial<AppSettings>): AppSettings {
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...overrides }
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify(merged, null, 2))
  return merged
}

/**
 * Launches an isolated Viking Relay instance:
 * - unique temp userData dir (--user-data-dir switch, probe-verified);
 * - optional pre-seeded settings.json;
 * - collectors attached before any meaningful work;
 * - readiness = window + shell bridge answering getState().
 */
export async function launchApp(options: LaunchOptions): Promise<AppHandle> {
  const label = options.label ?? 'server'
  const root = join(artifactRoot(), options.testId)
  mkdirSync(root, { recursive: true })
  const userDataDir = options.userDataDir ?? makeTempUserData(label)
  // Seed settings ONLY for fresh dirs or explicit overrides — re-seeding a
  // reused dir would wipe the persisted state a restart test depends on.
  if (options.settings || !existsSync(join(userDataDir, 'settings.json'))) {
    seedSettingsFile(userDataDir, options.settings ?? {})
  }

  // Launch with the REPO ROOT as the app dir so package.json is discovered:
  // app.getVersion() reports 0.4.3 and app.getAppPath()-based assets resolve.
  const args = ['.', `--user-data-dir=${userDataDir}`]
  if (options.hidden) args.push('--hidden')

  const app = await _electron.launch({
    args,
    cwd: REPO,
    env: { ...process.env, ...(options.env ?? {}) } as Record<string, string>
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  const handle = new AppHandle(app, page, {
    userDataDir,
    artifactsDir: root,
    label,
    keepUserDataOnClose: options.keepUserDataOnClose
  })
  await handle.marker('launched', { label, userDataDir })

  // Readiness: shell bridge must answer. Bounded, diagnostic on expiry.
  await handle.waitFor(
    'shell bridge ready (window.vikingRelay.getState)',
    async () => {
      try {
        const s = await page.evaluate(() =>
          window.vikingRelay ? window.vikingRelay.getState().then((x) => x.mode !== undefined) : false
        )
        return s === true
      } catch {
        return false
      }
    },
    { timeoutMs: 20_000 }
  )
  await handle.marker('bridge-ready')
  return handle
}
