/**
 * Typed qBittorrent WebUI API client (WebAPI v2.x, minimum 2.11.x).
 *
 * Endpoint/parameter facts verified against the official WebUI API wiki and
 * qBittorrent master sources (2026-08):
 * - GET  /app/version            -> plain text, e.g. "v5.2.0"
 * - GET  /app/webapiVersion      -> plain text, e.g. "2.11.9"
 * - POST /torrents/fetchMetadata -> form field `source`; HTTP 200 = full
 *   metadata JSON, HTTP 202 = still fetching (body: infohash-only object or {}),
 *   HTTP 400 = unparseable source / cannot download metadata.
 * - POST /torrents/add           -> multipart; `stopped`, `stopCondition`
 *   (None | MetadataReceived | FilesChecked), `savepath`, `category`, `tags`,
 *   `autoTMM`. Body "Ok." on success, "Fails." on failure.
 * - GET  /torrents/info          -> `hashes` pipe-separated; optional
 *   `includeFiles`.
 * - GET  /torrents/files         -> `hash`; empty array when metadata absent;
 *   per-file {index,name,size,progress,priority,...}.
 * - POST /torrents/filePrio      -> `hash`, `id` pipe-separated indexes,
 *   single `priority` value (0=do not download, 1=normal, 6=high, 7=maximal);
 *   works while the torrent is stopped.
 * - POST /torrents/start|stop    -> `hashes` (WebAPI >= 2.11.0 naming).
 * - POST /torrents/delete        -> `hashes`, `deleteFiles`.
 * - POST /torrents/createCategory|setCategory|createTags|addTags|removeTags.
 */

import {
  InvalidTorrentSourceError,
  QbitApiError,
  QbitAuthError,
  QbitTorrentErroredError,
  QbitUnreachableError,
  QbitUnsupportedVersionError,
} from './errors';
import { QbitTransport } from './http';
import type {
  QbitCapabilities,
  QbitClientConfig,
  QbitFetchMetadataResponse,
  QbitTorrentFile,
  QbitTorrentInfo,
} from './types';

export const DEFAULT_MIN_WEBAPI_VERSION = '2.11.9';
/** WebAPI version that introduced /torrents/fetchMetadata and /parseMetadata. */
export const FETCH_METADATA_WEBAPI_VERSION = '2.11.9';

export type FetchMetadataResult =
  | { state: 'pending' }
  | { state: 'ready'; meta: QbitFetchMetadataResponse };

export interface AddTorrentParams {
  urls: string[];
  savePath?: string;
  category?: string;
  tags?: string[];
  stopped?: boolean;
  stopCondition?: 'None' | 'MetadataReceived' | 'FilesChecked';
  autoTMM?: boolean;
}

export class QbitClient {
  private readonly transport: QbitTransport;
  private readonly usingApiKey: boolean;
  private readonly minWebApiVersion: string;
  private cachedCapabilities: QbitCapabilities | null = null;

  constructor(config: QbitClientConfig) {
    this.transport = new QbitTransport({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      username: config.username,
      password: config.password,
      timeoutMs: config.timeoutMs,
      fetchImpl: config.fetchImpl,
    });
    this.usingApiKey = Boolean(config.apiKey && config.apiKey.trim().length > 0);
    this.minWebApiVersion = config.minWebApiVersion ?? DEFAULT_MIN_WEBAPI_VERSION;
  }

  /* ------------------------------------------------------------------ */
  /* Version / health                                                    */
  /* ------------------------------------------------------------------ */

  async appVersion(): Promise<string> {
    const res = await this.transport.request('/api/v2/app/version');
    this.assertOk(res, '/app/version');
    return res.text.trim();
  }

  async webApiVersion(): Promise<string> {
    const res = await this.transport.request('/api/v2/app/webapiVersion');
    this.assertOk(res, '/app/webapiVersion');
    return res.text.trim();
  }

  /**
   * Health check + compatibility gate. Throws QbitUnsupportedVersionError when
   * the server is below the configured minimum, or when an API key is used
   * against a server older than 5.2.0 (API keys require >= 5.2.0).
   */
  async capabilities(forceRefresh = false): Promise<QbitCapabilities> {
    if (!forceRefresh && this.cachedCapabilities) return this.cachedCapabilities;

    let webApiVersion: string;
    try {
      webApiVersion = await this.webApiVersion();
    } catch (err) {
      // A server without /webapiVersion predates WebAPI 2.x entirely.
      if (err instanceof QbitApiError && err.details?.status === 404) {
        throw new QbitUnsupportedVersionError(
          'qBittorrent does not report a WebAPI version — too old for Viking Relay',
          { minimumWebApiVersion: this.minWebApiVersion },
        );
      }
      throw err;
    }

    const qbtVersion = await this.appVersion();

    if (compareVersions(webApiVersion, this.minWebApiVersion) < 0) {
      throw new QbitUnsupportedVersionError(
        `qBittorrent WebAPI ${webApiVersion} is below the supported minimum ${this.minWebApiVersion}`,
        { qbtVersion, webapiVersion: webApiVersion, minimumWebApiVersion: this.minWebApiVersion },
      );
    }

    if (this.usingApiKey && compareVersions(qbtVersion.replace(/^v/i, ''), '5.2.0') < 0) {
      throw new QbitUnsupportedVersionError(
        'API-key authentication requires qBittorrent >= 5.2.0',
        { qbtVersion, webapiVersion: webApiVersion, minimumWebApiVersion: this.minWebApiVersion },
      );
    }

    const tier =
      compareVersions(webApiVersion, FETCH_METADATA_WEBAPI_VERSION) >= 0
        ? ('fetchMetadata' as const)
        : ('addStopCondition' as const);

    this.cachedCapabilities = { qbtVersion, webApiVersion, tier };
    return this.cachedCapabilities;
  }

  /* ------------------------------------------------------------------ */
  /* Metadata inspection                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * One poll of POST /torrents/fetchMetadata.
   * - HTTP 200 with full metadata -> { state: 'ready', meta }
   * - HTTP 202 (or 200 without info) -> { state: 'pending' }
   * - HTTP 400/422 -> InvalidTorrentSourceError
   */
  async fetchMetadataOnce(source: string): Promise<FetchMetadataResult> {
    const res = await this.transport.request('/api/v2/torrents/fetchMetadata', {
      method: 'POST',
      form: { source },
    });

    if (res.status === 400 || res.status === 422) {
      throw invalidSourceFrom(res.text, source);
    }
    this.assertOk(res, '/torrents/fetchMetadata');

    if (res.status === 202) return { state: 'pending' };

    const json = this.parseJson(res, '/torrents/fetchMetadata');
    if (
      json &&
      typeof json === 'object' &&
      'info' in json &&
      typeof (json as { info?: unknown }).info === 'object'
    ) {
      return { state: 'ready', meta: json as QbitFetchMetadataResponse };
    }
    return { state: 'pending' };
  }

  /* ------------------------------------------------------------------ */
  /* Torrent lifecycle                                                   */
  /* ------------------------------------------------------------------ */

  async addTorrent(params: AddTorrentParams): Promise<void> {
    const fields: Record<string, string> = {
      urls: params.urls.join('\n'),
      autoTMM: boolParam(params.autoTMM ?? false),
    };
    if (params.savePath !== undefined) fields.savepath = params.savePath;
    if (params.category !== undefined) fields.category = params.category;
    if (params.tags?.length) fields.tags = params.tags.join(',');
    if (params.stopped !== undefined) fields.stopped = boolParam(params.stopped);
    if (params.stopCondition !== undefined) fields.stopCondition = params.stopCondition;

    const res = await this.transport.request('/api/v2/torrents/add', {
      method: 'POST',
      multipartFields: fields,
    });
    this.assertOk(res, '/torrents/add');

    const body = res.text.trim();
    if (/^Fails\.?$/i.test(body)) {
      throw new QbitApiError('qBittorrent refused to add the torrent ("Fails.")', {
        status: res.status,
        statusText: 'Fails.',
        endpoint: '/torrents/add',
      });
    }
  }

  async getTorrents(hashes?: string[], includeFiles = false): Promise<QbitTorrentInfo[]> {
    const res = await this.transport.request('/api/v2/torrents/info', {
      query: {
        hashes: hashes?.length ? hashes.map((h) => h.toLowerCase()).join('|') : undefined,
        includeFiles: includeFiles ? 'true' : undefined,
      },
    });
    this.assertOk(res, '/torrents/info');
    const json = this.parseJson(res, '/torrents/info');
    return Array.isArray(json) ? (json as QbitTorrentInfo[]) : [];
  }

  async getTorrentFiles(hash: string): Promise<QbitTorrentFile[]> {
    const res = await this.transport.request('/api/v2/torrents/files', {
      query: { hash: hash.toLowerCase() },
    });
    this.assertOk(res, '/torrents/files');
    const json = this.parseJson(res, '/torrents/files');
    return Array.isArray(json) ? (json as QbitTorrentFile[]) : [];
  }

  /** priority: 0 = do not download, 1 = normal, 6 = high, 7 = maximal. */
  async setFilePriority(hash: string, fileIndexes: number[], priority: 0 | 1 | 6 | 7): Promise<void> {
    if (fileIndexes.length === 0) return;
    const res = await this.transport.request('/api/v2/torrents/filePrio', {
      method: 'POST',
      form: {
        hash: hash.toLowerCase(),
        id: fileIndexes.join('|'),
        priority: String(priority),
      },
    });
    this.assertOk(res, '/torrents/filePrio');
  }

  async startTorrents(hashes: string[]): Promise<void> {
    const res = await this.transport.request('/api/v2/torrents/start', {
      method: 'POST',
      form: { hashes: hashes.map((h) => h.toLowerCase()).join('|') },
    });
    this.assertOk(res, '/torrents/start');
  }

  async stopTorrents(hashes: string[]): Promise<void> {
    const res = await this.transport.request('/api/v2/torrents/stop', {
      method: 'POST',
      form: { hashes: hashes.map((h) => h.toLowerCase()).join('|') },
    });
    this.assertOk(res, '/torrents/stop');
  }

  async deleteTorrents(hashes: string[], deleteFiles: boolean): Promise<void> {
    if (hashes.length === 0) return;
    const res = await this.transport.request('/api/v2/torrents/delete', {
      method: 'POST',
      form: {
        hashes: hashes.map((h) => h.toLowerCase()).join('|'),
        deleteFiles: boolParam(deleteFiles),
      },
    });
    this.assertOk(res, '/torrents/delete');
  }

  /* ------------------------------------------------------------------ */
  /* Ownership markers                                                   */
  /* ------------------------------------------------------------------ */

  async createCategory(name: string, savePath?: string): Promise<void> {
    const res = await this.transport.request('/api/v2/torrents/createCategory', {
      method: 'POST',
      form: { category: name, ...(savePath !== undefined ? { savePath } : {}) },
    });
    if (res.status === 400 || res.status === 409 || res.status === 415) return; // likely exists
    this.assertOk(res, '/torrents/createCategory');
  }

  async setCategory(hashes: string[], category: string): Promise<void> {
    const res = await this.transport.request('/api/v2/torrents/setCategory', {
      method: 'POST',
      form: { hashes: hashes.map((h) => h.toLowerCase()).join('|'), category },
    });
    this.assertOk(res, '/torrents/setCategory');
  }

  async createTags(tags: string[]): Promise<void> {
    if (!tags.length) return;
    const res = await this.transport.request('/api/v2/torrents/createTags', {
      method: 'POST',
      form: { tags: tags.join(',') },
    });
    if (res.status === 400 || res.status === 409) return; // likely exists
    this.assertOk(res, '/torrents/createTags');
  }

  async addTags(hashes: string[], tags: string[]): Promise<void> {
    if (!tags.length) return;
    const res = await this.transport.request('/api/v2/torrents/addTags', {
      method: 'POST',
      form: { hashes: hashes.map((h) => h.toLowerCase()).join('|'), tags: tags.join(',') },
    });
    this.assertOk(res, '/torrents/addTags');
  }

  async removeTags(hashes: string[], tags: string[]): Promise<void> {
    if (!tags.length) return;
    const res = await this.transport.request('/api/v2/torrents/removeTags', {
      method: 'POST',
      form: { hashes: hashes.map((h) => h.toLowerCase()).join('|'), tags: tags.join(',') },
    });
    this.assertOk(res, '/torrents/removeTags');
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  private assertOk(res: { ok: boolean; status: number; text: string }, endpoint: string): void {
    if (res.status === 401 || res.status === 403) throw new QbitAuthError();
    if (!res.ok) {
      throw new QbitApiError(`qBittorrent API call failed (${endpoint}, HTTP ${res.status})`, {
        status: res.status,
        statusText: res.text.slice(0, 200),
        endpoint,
      });
    }
  }

  private parseJson(res: { text: string }, endpoint: string): unknown {
    if (!res.text.trim()) return null;
    try {
      return JSON.parse(res.text);
    } catch {
      throw new QbitApiError(`qBittorrent returned non-JSON payload for ${endpoint}`, {
        status: 200,
        statusText: res.text.slice(0, 120),
        endpoint,
      });
    }
  }
}

function invalidSourceFrom(responseText: string, source: string): InvalidTorrentSourceError {
  return new InvalidTorrentSourceError(
    `qBittorrent could not use the torrent source: ${responseText.trim().slice(0, 200) || 'rejected'}`,
    { source },
  );
}

function boolParam(value: boolean): 'true' | 'false' {
  return value ? 'true' : 'false';
}

/** Numeric tuple comparison of dotted versions ("2.11.9"). Returns -1/0/1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

// Re-exported so callers can catch precisely without importing http/errors chains.
export { QbitUnreachableError, QbitTorrentErroredError };
