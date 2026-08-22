/**
 * DirectDownloadsService — "friend mode" receiver on the CLIENT PC.
 *
 * Polls the paired server for direct-download jobs, then either auto-accepts
 * them (trust switch ON) or queues them locally for manual approval. Accepted
 * jobs go into the friend's OWN qBittorrent (magnet/.torrent) or are fetched
 * straight to disk (direct links). Nothing is zipped or uploaded.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppSettingsStore } from '../settings-store';
import type { SecretStore } from '../secrets';
import { ApiRoutes } from '@shared/api';
import { HttpDirectDownloadGateway } from '../integration/direct-gateway';
import { QbitTorrentService } from '../qbit/service';
import type { Logger } from 'pino';
import type { ClientRelayService } from './service';

export const SECRET_CLIENT_QBIT_KEY = 'client.qbitApiKey';

export interface DirectDownloadItem {
  id: string;
  source: string;
  sourceKind: 'magnet' | 'url' | 'direct';
  /** pending | downloading | done | failed | declined */
  state: 'pending' | 'downloading' | 'done' | 'failed' | 'declined';
  error?: string | null;
  createdAt: string;
}

interface QueueFile {
  version: 1;
  items: DirectDownloadItem[];
}

export interface DirectDownloadSettingsView {
  autoAccept: boolean;
  qbitUrl: string;
  qbitKeySet: boolean;
  downloadDir: string | null;
}

export class DirectDownloadsService {
  readonly #gateway = new HttpDirectDownloadGateway();
  #polling = false;

  constructor(
    private readonly settings: AppSettingsStore,
    private readonly secrets: SecretStore,
    private readonly relay: ClientRelayService,
    private readonly userDataDir: string,
    private readonly log: Logger,
  ) {}

  // ------------------------------------------------------------- settings

  getSettings(): DirectDownloadSettingsView {
    const s = this.settings.get();
    return {
      autoAccept: s.directAutoAccept,
      qbitUrl: s.clientQbitUrl,
      qbitKeySet: this.secrets.get(SECRET_CLIENT_QBIT_KEY) !== null,
      downloadDir: s.clientDownloadDir,
    };
  }

  setSettings(patch: {
    autoAccept?: boolean;
    qbitUrl?: string;
    qbitKey?: string;
    downloadDir?: string | null;
  }): DirectDownloadSettingsView {
    const mapped: Record<string, unknown> = {};
    if (patch.autoAccept !== undefined) mapped.directAutoAccept = patch.autoAccept;
    if (patch.qbitUrl !== undefined) mapped.clientQbitUrl = patch.qbitUrl.trim();
    if (patch.downloadDir !== undefined) mapped.clientDownloadDir = patch.downloadDir;
    if (Object.keys(mapped).length > 0) this.settings.update(mapped);
    if (typeof patch.qbitKey === 'string' && patch.qbitKey.trim().length > 0) {
      this.secrets.set(SECRET_CLIENT_QBIT_KEY, patch.qbitKey.trim());
    }
    return this.getSettings();
  }

  // ---------------------------------------------------------------- queue

  async listLocal(): Promise<DirectDownloadItem[]> {
    return (await this.#loadQueue()).slice().reverse();
  }

  async accept(id: string): Promise<DirectDownloadItem[]> {
    await this.#downloadPending(id);
    await this.#remoteAction(id, 'accept').catch(() => {});
    return this.listLocal();
  }

  async decline(id: string): Promise<DirectDownloadItem[]> {
    await this.#markLocal(id, { state: 'declined' });
    await this.#remoteAction(id, 'decline').catch(() => {});
    return this.listLocal();
  }

  /** One poll cycle; safe to call on a timer. Failures are logged, never thrown. */
  async pollOnce(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const status = await this.relay.connectionStatus();
      if (status.state !== 'connected') return;
      const token = this.relay.tokenForPolling();
      const client = this.relay.httpClient();
      if (!token || !client) return;

      const response = await client.request<{ jobs: Array<{ id: string; source: string; sourceKind: 'magnet' | 'url' | 'direct' }> }>(
        'GET',
        ApiRoutes.directJobs,
        undefined,
        { token },
      );

      const known = new Set((await this.#loadQueue()).map((i) => i.id));
      for (const job of response.jobs) {
        if (known.has(job.id)) continue;
        await this.#appendLocal({
          id: job.id,
          source: job.source,
          sourceKind: job.sourceKind,
          state: 'pending',
          createdAt: new Date().toISOString(),
        });
        this.log.info({ jobId: job.id }, 'direct download received');
        if (this.settings.get().directAutoAccept) {
          await this.accept(job.id).catch((err) => {
            this.log.warn({ err: String(err), jobId: job.id }, 'auto-accept failed');
          });
        }
      }
    } catch (error) {
      this.log.debug?.({ err: String(error) }, 'direct-jobs poll skipped');
    } finally {
      this.#polling = false;
    }
  }

  // ------------------------------------------------------------ internals

  async #downloadPending(id: string): Promise<void> {
    const items = await this.#loadQueue();
    const item = items.find((i) => i.id === id);
    if (!item || item.state === 'done' || item.state === 'downloading') return;

    const s = this.settings.get();
    if (!s.clientDownloadDir) {
      await this.#markLocal(id, { state: 'failed', error: 'set a download folder first' });
      return;
    }

    item.state = 'downloading';
    item.error = null;
    await this.#saveQueue(items);

    try {
      if (item.sourceKind === 'direct') {
        const filename = decodeURIComponent(item.source.split('/').pop() ?? 'download.bin');
        const dest = join(s.clientDownloadDir, filename);
        await mkdir(dirname(dest), { recursive: true });
        await this.#gateway.fetchTo(item.source, dest);
      } else {
        const apiKey = this.secrets.get(SECRET_CLIENT_QBIT_KEY) ?? undefined;
        if (!s.clientQbitUrl) throw new Error('qBittorrent URL is not configured');
        const qbit = new QbitTorrentService({ baseUrl: s.clientQbitUrl, apiKey });
        await qbit.client.addTorrent({
          urls: [item.source],
          savePath: s.clientDownloadDir,
          autoTMM: false,
        });
      }
      item.state = 'done';
      this.log.info({ id, kind: item.sourceKind }, 'direct download accepted and started');
    } catch (error) {
      item.state = 'failed';
      item.error = error instanceof Error ? error.message : String(error);
      this.log.warn({ err: item.error, id }, 'direct download failed');
    }
    await this.#saveQueue(items);
  }

  async #remoteAction(id: string, action: 'accept' | 'decline'): Promise<void> {
    const token = this.relay.tokenForPolling();
    const client = this.relay.httpClient();
    if (!token || !client) return;
    await client.request('POST', ApiRoutes.directJobAction(id, action), undefined, { token });
  }

  async #markLocal(id: string, patch: Partial<DirectDownloadItem>): Promise<void> {
    const items = await this.#loadQueue();
    const item = items.find((i) => i.id === id);
    if (!item) return;
    Object.assign(item, patch);
    await this.#saveQueue(items);
  }

  async #appendLocal(item: DirectDownloadItem): Promise<void> {
    const items = await this.#loadQueue();
    items.push(item);
    await this.#saveQueue(items);
  }

  #queuePath(): string {
    return join(this.userDataDir, 'data', 'direct-downloads.json');
  }

  async #loadQueue(): Promise<DirectDownloadItem[]> {
    try {
      const raw = await readFile(this.#queuePath(), 'utf8');
      const parsed = JSON.parse(raw) as QueueFile;
      return parsed.version === 1 && Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      return [];
    }
  }

  async #saveQueue(items: DirectDownloadItem[]): Promise<void> {
    const file = this.#queuePath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, items } satisfies QueueFile, null, 2), 'utf8');
  }
}
