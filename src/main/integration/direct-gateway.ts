/**
 * Direct HTTP(S) download gateway — streams a non-torrent URL to disk.
 * Used when an intake URL does not point at a .torrent file: the server
 * fetches the payload itself, bypassing qBittorrent entirely.
 */
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import type { DirectDownloadGateway } from '../jobs/gateways.ts';

const PROBE_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

export class HttpDirectDownloadGateway implements DirectDownloadGateway {
  async probe(url: string): Promise<{ filename: string; sizeBytes: number }> {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    try {
      const filename = filenameFrom(response, url);
      let sizeBytes = 0;
      const range = response.headers.get('content-range');
      const total = range ? Number(/\/(\d+)$/.exec(range)?.[1]) : NaN;
      if (Number.isFinite(total) && total > 0) {
        sizeBytes = total;
      } else if (response.status === 200) {
        sizeBytes = Number(response.headers.get('content-length') ?? 0) || 0;
      }
      return { filename, sizeBytes };
    } finally {
      // Drain + close without writing anything to disk.
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
    }
  }

  async fetchTo(
    url: string,
    destPath: string,
    onProgress?: (downloaded: number, total: number | null) => void,
  ): Promise<{ bytes: number }> {
    const response = await fetchWithTimeout(url, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} while fetching ${url}`);
    }
    const totalHeader = Number(response.headers.get('content-length') ?? 0);
    const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;

    const out = createWriteStream(destPath);
    let downloaded = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        downloaded += value.byteLength;
        if (!out.write(Buffer.from(value))) {
          await new Promise<void>((resolve, reject) => {
            out.once('drain', resolve);
            out.once('error', reject);
          });
        }
        onProgress?.(downloaded, total);
      }
      await new Promise<void>((resolve, reject) => {
        out.end(resolve);
        out.once('error', reject);
      });
    } catch (error) {
      out.destroy();
      await unlink(destPath).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return { bytes: downloaded };
  }
}

function fetchWithTimeout(
  url: string,
  init: { method?: string; headers?: Record<string, string>; timeoutMs: number },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), init.timeoutMs);
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    redirect: 'follow',
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

function filenameFrom(response: Response, url: string): string {
  const disposition = response.headers.get('content-disposition');
  const match = disposition
    ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)
    : null;
  if (match?.[1]) return sanitize(path.basename(match[1]));
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    if (base) return sanitize(base);
  } catch {
    /* fall through */
  }
  return 'download.bin';
}

function sanitize(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 180) : 'download.bin';
}
