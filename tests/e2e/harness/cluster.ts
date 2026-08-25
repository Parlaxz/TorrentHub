import type { AppSettings } from '../../../src/shared/settings'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { launchApp, AppHandle } from './app'
import { getFreePort, lanetAddress, makeTempUserData } from './paths'
import { createMockQbit, type MockQbit, type QbitScenario } from './qbit-server'
import { createMockViking, type MockViking, type MockVikingOptions } from '../../../tests/viking/helpers/mock-server'

/**
 * Two-instance cluster fixtures: a fully-configured SERVER app (real relay,
 * real job engine; qBittorrent + Viking pointed at local wire-level mocks)
 * and CLIENT apps paired against it through the real UI/IPC paths.
 */

export const E2E_QBIT_KEY = 'e2e-qbit-key'
export const E2E_MAGNET =
  'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Movie%202024&tr=http://tracker.e2e/announce'

export interface ServerCluster {
  app: AppHandle
  qbit: MockQbit
  viking: MockViking
  relayPort: number
  relayAddress: string
  dataDir: string
  /** Local direct-link front URL the mocked Viking complete-upload points at. */
  directUrl: string
  close(): Promise<void>
}

export interface LaunchServerOptions {
  testId: string
  label?: string
  qbitScenario?: QbitScenario
  vikingOptions?: MockVikingOptions
  /** Extra settings overrides on top of the standard server fixture. */
  settings?: Partial<AppSettings>
  /** Skip auto-starting the relay (tests that start it themselves). Default false. */
  skipAutoStart?: boolean
}

/**
 * Local direct-link front covering BOTH resolver paths:
 * - HEADLESS: POST /f/<id> → { link } JSON (VikingClient.resolveDirectLink)
 * - WINDOW FALLBACK: GET /f/<id> → HTML with #download-link anchor
 * Without it, a completed upload pointing at vikingfile.com would make the
 * product's finalize step hit the REAL host and hang up to 90 s.
 */
function createDirectLinkFront(): Promise<{ port: number; directUrl: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (/^\/f\/[A-Za-z0-9]+$/.test(url.pathname)) {
        const direct = `http://127.0.0.1:${(server.address() as AddressInfo).port}/d/E2EDIRECT/file`
        if (req.method === 'POST') {
          await new Promise<Buffer>((resolve) => {
            const chunks: Buffer[] = []
            req.on('data', (c: Buffer) => chunks.push(c))
            req.on('end', () => resolve(Buffer.concat(chunks)))
          })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ link: direct }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<html><body><a id="download-link" href="${direct}">download</a></body></html>`)
        return
      }
      res.writeHead(404).end('not found')
    })().catch(() => {
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        directUrl: `http://127.0.0.1:${port}/d/E2EDIRECT/file`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
            server.closeAllConnections()
          })
      })
    })
  })
}

export async function launchServer(options: LaunchServerOptions): Promise<ServerCluster> {
  const label = options.label ?? 'server'
  const qbit = await createMockQbit({ requireApiKey: E2E_QBIT_KEY, ...options.qbitScenario })
  const front = await createDirectLinkFront()
  const vikingOptions: MockVikingOptions = { ...options.vikingOptions }
  if (!vikingOptions.completeResponse) {
    // Point the completed upload at the LOCAL front so the direct-link
    // resolver resolves instantly against our own page.
    vikingOptions.completeResponse = {
      name: 'upload.zip',
      size: 1,
      hash: 'TPRSfLvcIu',
      url: `http://127.0.0.1:${front.port}/f/TPRSfLvcIu`
    }
  }
  const viking = await createMockViking(vikingOptions)
  const relayPort = await getFreePort()
  const relayAddress = lanetAddress()
  if (!relayAddress) throw new Error('no bindable IPv4 address found for relay fixture')

  const dataDir = makeTempUserData(`${label}-data`)
  const app = await launchApp({
    testId: options.testId,
    label,
    env: { VIKING_BASE_URL: viking.url },
    settings: {
      mode: 'server',
      // Landing on the Dashboard requires workingFolderPath (dataDir) set.
      dataDir,
      qbittorrentBaseUrl: qbit.url,
      radminInterfaceId: relayAddress,
      serverPort: relayPort,
      ...(options.settings ?? {})
    }
  })

  // Arrange-only secret provisioning through the SAME IPC the SettingsPanel
  // uses (secrets are DPAPI-encrypted and cannot be pre-seeded from outside).
  await app.page.evaluate(
    ([key]) => window.vikingRelayServer.setQbitApiKey(key as string),
    [E2E_QBIT_KEY]
  )

  let health: Record<string, unknown> | null = null
  if (!options.skipAutoStart) {
    health = await startRelay(app)
  }

  void health
  return {
    app,
    qbit,
    viking,
    relayPort,
    relayAddress,
    dataDir,
    directUrl: front.directUrl,
    close: async () => {
      await app.close()
      await qbit.close()
      await viking.close()
      await front.close()
    }
  }
}

/** Starts the relay via the same bridge call the Dashboard Start button makes. */
export async function startRelay(app: AppHandle): Promise<Record<string, unknown>> {
  const snapshot = (await app.serverBridge<Record<string, unknown>>('startServer()')) as Record<string, unknown>
  await app.waitFor('relay online', async () => {
    const h = (await app.serverBridge<Record<string, unknown>>('getHealth()')) as Record<string, unknown>
    return h['online'] === true
  })
  return snapshot
}

export interface PairedClient {
  app: AppHandle
  close(): Promise<void>
}

/**
 * Pairs a fresh client instance to the cluster through the REAL ConnectScreen
 * UI using a code generated by the real pairing modal backend.
 */
export async function pairClient(options: {
  testId: string
  server: ServerCluster
  name?: string
  label?: string
}): Promise<PairedClient> {
  const generated = (await options.server.app.serverBridge<Record<string, unknown>>(
    'generatePairingCode()'
  )) as Record<string, unknown>
  const code = extractCode(generated)
  if (!code) throw new Error(`no pairing code in response: ${JSON.stringify(generated)}`)

  const client = await launchApp({
    testId: options.testId,
    label: options.label ?? 'client',
    settings: { mode: 'client' }
  })

  const page = client.page
  await expectVisible(page, 'Pair & Connect')
  await fillField(page, 'Server IP', options.server.relayAddress)
  await fillField(page, 'Port', String(options.server.relayPort))
  await fillField(page, 'Pairing Code', code)
  await page.getByRole('button', { name: /Pair & Connect/ }).click()

  await client.waitFor(
    'client reaches connected home screen',
    async () => {
      try {
        const conn = (await page.evaluate(() => window.vikingClientBridge.getConnection())) as
          | { host?: string }
          | null
          | undefined
        return Boolean(conn && conn.host)
      } catch {
        return false
      }
    },
    { timeoutMs: 20_000 }
  )
  await client.marker('paired', { name: options.name })
  return {
    app: client,
    close: async () => {
      await client.close()
    }
  }
}

/* ------------------------------------------------------------------ */
/* small UI helpers shared by lanes                                    */

export async function expectVisible(
  pageOrApp: AppHandle | AppHandle['page'],
  text: string
): Promise<void> {
  const page = pageOrApp instanceof AppHandle ? pageOrApp.page : pageOrApp
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 10_000 })
}

export async function fillField(page: AppHandle['page'], label: string, value: string): Promise<void> {
  // Field component renders <label><span>…</span><input/></label>-style markup;
  // locate by associated label text then fill the inner input.
  const field = page.getByText(label, { exact: true }).first()
  const input = field.locator('xpath=following::input[1]')
  await input.fill(value)
}

function extractCode(payload: Record<string, unknown>): string | null {
  if (typeof payload['code'] === 'string') return payload['code']
  if (typeof payload['pairingCode'] === 'string') return payload['pairingCode'] as string
  const nested = payload['pairing']
  if (nested && typeof nested === 'object') return extractCode(nested as Record<string, unknown>)
  return null
}
