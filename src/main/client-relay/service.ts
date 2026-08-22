/**
 * ClientRelayService — Client Mode backend in ELECTRON MAIN.
 *
 * Owns the saved Server PC connection (host/port as normal settings; bearer
 * token encrypted via safeStorage) and every REST call the Client UI needs.
 * The renderer only ever sees narrow IPC results — never the token, never
 * qBittorrent/Viking credentials, never server filesystem paths.
 */
import { ApiRoutes } from '@shared/api'
import type { IntakeDraftView, JobSnapshot } from '@shared/domain'
import type { AppSettingsStore } from '../settings-store'
import type { SecretStore } from '../secrets'
import { RelayClientError, RelayHttpClient, isValidServerHost } from './http-client'

export const SECRET_CLIENT_BEARER = 'client.bearerToken'

export interface SavedConnection {
  host: string
  port: number
}

export type ConnectionState = 'connected' | 'reconnecting' | 'offline' | 'unpaired'

export interface ConnectionStatus {
  state: ConnectionState
  host?: string
  port?: number
}

/** Authoritative storage preflight (server-computed; renderer never does math). */
export interface StoragePreflight {
  selectedFiles: number
  selectedBytes: number
  tempZipBytes: number | null
  safetyReserveBytes: number | null
  peakRequiredBytes: number | null
  serverFreeBytes: number | null
  enough: boolean
  missingBytes: number | null
  blocked: boolean
}

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface HistoryEntry {
  id: string
  name: string
  state: string
  sizeBytes: number | null
  completedAt: string | null
  url: string | null
}

interface JobResponse extends JobSnapshot {
  storagePreflight?: StoragePreflight | null
}

function startKey(jobId: string): string {
  return `start-${jobId}`
}

export class ClientRelayService {
  constructor(
    private readonly settings: AppSettingsStore,
    private readonly secrets: SecretStore,
  ) {}

  // ----------------------------------------------------------- connection

  getConnection(): SavedConnection | null {
    const s = this.settings.get()
    if (!s.clientServerHost) return null
    return { host: s.clientServerHost, port: s.clientServerPort }
  }

  async pair(host: string, port: number, code: string): Promise<BridgeResult<SavedConnection>> {
    const cleanHost = host.trim()
    if (!isValidServerHost(cleanHost)) {
      return { ok: false, error: 'enter a valid server IPv4 address' }
    }
    const client = new RelayHttpClient({ host: cleanHost, port })
    try {
      const result = await client.request<{ clientId: string; name: string; token: string }>(
        'POST',
        ApiRoutes.pair,
        { code: code.trim().toUpperCase() },
        { timeoutMs: 8000 },
      )
      if (!this.secrets.set(SECRET_CLIENT_BEARER, result.token)) {
        return { ok: false, error: 'secure storage unavailable — cannot save the pairing token' }
      }
      this.settings.update({ clientServerHost: cleanHost, clientServerPort: port })
      return { ok: true, value: { host: cleanHost, port } }
    } catch (error) {
      return { ok: false, error: describe(error) }
    }
  }

  forgetConnection(): void {
    this.secrets.delete(SECRET_CLIENT_BEARER)
    this.settings.update({ clientServerHost: null })
  }

  private token(): string | null {
    return this.secrets.get(SECRET_CLIENT_BEARER)
  }

  private client(): RelayHttpClient | null {
    const conn = this.getConnection()
    return conn ? new RelayHttpClient(conn) : null
  }

  async connectionStatus(): Promise<ConnectionStatus> {
    const conn = this.getConnection()
    if (!conn || !this.token()) return { state: 'unpaired' }
    try {
      await this.client()!.health()
      return { state: 'connected', host: conn.host, port: conn.port }
    } catch (error) {
      return {
        state: error instanceof RelayClientError && error.kind === 'unauthorized'
          ? 'offline'
          : 'offline',
        host: conn.host,
        port: conn.port,
      }
    }
  }

  // --------------------------------------------------------------- intake

  async createIntake(sourceInput: string): Promise<{ jobId: string }> {
    const value = sourceInput.trim()
    const kind = value.startsWith('magnet:') ? 'magnet' : 'url'
    if (kind === 'url' && !/^https?:\/\//i.test(value)) {
      throw new RelayClientError({
        kind: 'validation',
        message: 'paste a magnet link or an http(s) torrent URL',
      })
    }
    const view = await this.authed<JobSnapshot & { id: string }>('POST', ApiRoutes.intakes, {
      source: { kind, value },
    })
    return { jobId: view.id }
  }

  async getDraft(intakeId: string): Promise<IntakeDraftView> {
    return this.authed<IntakeDraftView>(
      'GET',
      ApiRoutes.intakeById(encodeURIComponent(intakeId)),
    )
  }

  // ----------------------------------------------------------------- jobs

  /**
   * Confirms the selection and runs the authoritative storage preflight.
   * When Start is blocked for insufficient disk the response still carries
   * the full preflight figures (blocked=true) so the UI can show the exact
   * deficit; the job stays awaiting_selection on the server.
   */
  async confirmSelection(
    jobId: string,
    fileIndexes: number[],
  ): Promise<BridgeResult<StoragePreflight>> {
    const indexes = [...new Set(fileIndexes)].sort((a, b) => a - b)
    if (indexes.length === 0) {
      return { ok: false, error: 'select at least one file' }
    }
    try {
      const job = await this.authed<JobResponse>('POST', ApiRoutes.jobs, {
        intakeId: jobId,
        selection: indexes,
        idempotencyKey: startKey(jobId),
      })
      const preflight = job.storagePreflight ?? job.preflight ?? null
      if (!preflight) {
        return { ok: false, error: 'server did not return a storage preflight' }
      }
      return { ok: true, value: preflight }
    } catch (error) {
      return { ok: false, error: describe(error) }
    }
  }

  /**
   * Start/Start-retry: replays POST /v1/jobs with the SAME idempotency key.
   * If the original commit already started the transfer the engine returns
   * the same job unchanged; if the first attempt was lost in flight — or the
   * user is retrying Start after freeing disk space — this commits with the
   * job's PERSISTED selection (set before preflight, even on the blocked
   * path), never a re-derived one.
   */
  async startJob(jobId: string): Promise<void> {
    const job = await this.getJob(jobId).catch(() => null);
    const selection = job?.selection ?? [];
    if (selection.length === 0) {
      throw new RelayClientError({
        kind: 'validation',
        message: 'confirm the file selection first',
      });
    }
    await this.authed<JobResponse>('POST', ApiRoutes.jobs, {
      intakeId: jobId,
      selection,
      idempotencyKey: startKey(jobId),
    });
  }

  async getJob(jobId: string): Promise<JobSnapshot> {
    return this.authed<JobSnapshot>('GET', ApiRoutes.jobById(encodeURIComponent(jobId)))
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.authed('POST', ApiRoutes.cancelJob(encodeURIComponent(jobId)))
  }

  async retryPackaging(jobId: string): Promise<void> {
    await this.authed('POST', ApiRoutes.retryPackaging(encodeURIComponent(jobId)))
  }

  async retryUpload(jobId: string): Promise<void> {
    await this.authed('POST', ApiRoutes.retryUpload(encodeURIComponent(jobId)))
  }

  /** Fresh disk check, then packaging continues when safe. */
  async retryStorageCheck(jobId: string): Promise<void> {
    await this.authed('POST', ApiRoutes.recheckStorage(encodeURIComponent(jobId)))
  }

  async listHistory(): Promise<HistoryEntry[]> {
    const response = await this.authed<{ history: JobSnapshot[] }>(
      'GET',
      `${ApiRoutes.history}?limit=50`,
    )
    return response.history.map((j) => ({
      id: j.id,
      name: j.metadata?.name ?? j.source.value,
      state: j.state,
      sizeBytes: j.selectedBytes ?? j.metadata?.totalSizeBytes ?? null,
      completedAt: j.updatedAt ?? null,
      url: j.result?.url ?? null,
    }))
  }

  // ------------------------------------------------------------- internals

  private async authed<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const client = this.client()
    const token = this.token()
    if (!client || !token) {
      throw new RelayClientError({ kind: 'unauthorized', message: 'not paired to a server yet' })
    }
    return client.request<T>(method, path, body, { token })
  }
}

function describe(error: unknown): string {
  if (error instanceof RelayClientError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
