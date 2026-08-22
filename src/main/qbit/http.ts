/**
 * Thin HTTP transport for the qBittorrent WebUI API.
 *
 * Deliberately hand-rolled on top of fetch (no SDK):
 * - API-key auth (`Authorization: Bearer qbt_...`, qBittorrent >= 5.2)
 * - cookie-session fallback (POST /api/v2/auth/login -> SID cookie)
 * - per-request timeout via AbortController
 * - explicit typed errors for unreachable/bad-credentials cases
 *
 * Verified against qBittorrent master sources (2026-08):
 * - cookie requests must carry a Referer/Origin matching the Host exactly;
 *   we always send Referer derived from baseUrl (harmless with API keys).
 * - 204 is a valid EMPTY success response (qBittorrent 5.2+).
 */

import { QbitAuthError, QbitUnreachableError } from './errors';

export interface TransportConfig {
  baseUrl: string;
  apiKey?: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RawResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string | undefined>;
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, string>;
  /** multipart/form-data body (required by /torrents/add). */
  multipartFields?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class QbitTransport {
  private readonly baseUrl: string;
  private readonly refererOrigin: string;
  private readonly apiKey?: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private sessionId: string | null = null;

  constructor(config: TransportConfig) {
    const trimmed = config.baseUrl.trim().replace(/\/+$/, '');
    let parsedBase: URL;
    try {
      parsedBase = new URL(trimmed);
    } catch {
      throw new Error(`Invalid qBittorrent WebUI base URL: "${config.baseUrl}"`);
    }
    this.baseUrl = parsedBase.toString();
    this.refererOrigin = parsedBase.origin;
    this.apiKey = config.apiKey?.trim() || undefined;
    this.username = config.username;
    this.password = config.password ?? '';
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Performs a request. Throws QbitUnreachableError on network failure or
   * timeout. Returns the raw response otherwise (status mapping is up to the
   * caller unless retryable-auth applies).
   */
  async request(path: string, options: RequestOptions = {}): Promise<RawResponse> {
    // Cookie mode authenticates lazily but PROACTIVELY: qBittorrent answers
    // unauthenticated API calls with 403, and we prefer one clean login over
    // a guaranteed round-trip failure.
    if (!this.apiKey && !path.startsWith('/auth/')) {
      await this.ensureAuthenticated();
    }

    const url = this.buildUrl(path, options.query);

    const doFetch = (): Promise<RawResponse> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const init = this.buildInit(url, options, controller.signal);
      return this.fetchImpl(url.toString(), init)
        .then(async (res) => ({ status: res.status, ok: res.ok, headers: res.headers, text: await res.text() }))
        .finally(() => clearTimeout(timer));
    };

    let res: RawResponse;
    try {
      res = await doFetch();
    } catch (err) {
      if (err instanceof QbitUnreachableError) throw err;
      throw new QbitUnreachableError(this.describeNetworkError(err), {
        url: url.toString(),
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    // Cookie-mode auth retry: session may have expired server-side.
    if (res.status === 403 && !this.apiKey && !path.startsWith('/auth/')) {
      await this.login();
      try {
        res = await doFetch();
      } catch (err) {
        throw new QbitUnreachableError(this.describeNetworkError(err), { url: url.toString() });
      }
      if (res.status === 403) throw new QbitAuthError();
    }

    return res;
  }

  /** Ensures a cookie session exists (cookie-mode only). */
  async ensureAuthenticated(): Promise<void> {
    if (this.apiKey) return;
    if (this.sessionId) return;
    await this.login();
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): URL {
    const url = new URL(path.replace(/^\/+/, ''), this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, value);
      }
    }
    return url;
  }

  private buildInit(_url: URL, options: RequestOptions, signal: AbortSignal): RequestInit {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      Referer: this.refererOrigin,
    };

    let body: string | undefined;

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    } else if (this.sessionId) {
      headers.Cookie = `SID=${this.sessionId}`;
    }

    if (method === 'POST') {
      if (options.multipartFields) {
        const boundary = `vr-qbit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
        body = encodeMultipart(options.multipartFields, boundary);
      } else if (options.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(options.form).toString();
      }
    }

    return { method, headers, body, signal };
  }

  private async login(): Promise<void> {
    if (!this.username) {
      throw new QbitAuthError(
        'No API key configured and no username/password provided for cookie authentication',
      );
    }
    const url = this.buildUrl('/api/v2/auth/login');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const loginBody = new URLSearchParams();
    loginBody.set('username', this.username);
    loginBody.set('password', this.password ?? '');
    let res: Awaited<ReturnType<typeof this.fetchImpl>>;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: this.refererOrigin,
        },
        body: loginBody.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      throw new QbitUnreachableError(this.describeNetworkError(err), { url: url.toString() });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (res.status === 403 || !res.ok || !/^Ok\.?$/i.test(text.trim())) {
      throw new QbitAuthError(
        `qBittorrent rejected credentials (HTTP ${res.status}: ${text.trim().slice(0, 120)})`,
      );
    }

    this.sessionId = extractSid(res.headers);
    if (!this.sessionId) {
      throw new QbitAuthError('qBittorrent login succeeded but no SID cookie was returned');
    }
  }

  private describeNetworkError(err: unknown): string {
    if (err instanceof Error && err.name === 'AbortError') {
      return `qBittorrent request timed out after ${this.timeoutMs}ms`;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `qBittorrent WebUI unreachable at ${this.baseUrl} (${msg})`;
  }
}

function encodeMultipart(fields: Record<string, string>, boundary: string): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`,
    );
  }
  parts.push(`--${boundary}--\r\n`);
  return parts.join('');
}

function extractSid(headers: Headers): string | null {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  const cookies =
    typeof h.getSetCookie === 'function'
      ? h.getSetCookie()
      : [headers.get('set-cookie') ?? []].flat();
  for (const cookie of cookies) {
    const match = /(?:^|;\s*)SID=([^;]+)/.exec(cookie);
    if (match) return match[1];
  }
  return null;
}
