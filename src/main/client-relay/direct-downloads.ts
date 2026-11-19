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
import { parseTorrentSource } from '../qbit/magnet';
import { QbitTorrentService } from '../qbit/service';
import type { Logger } from 'pino';
import type { ClientRelayService } from './service';

export const SECRET_CLIENT_QBIT_KEY = 'client.qbitApiKey';

export interface DirectDownloadItem {
  id: string;
  source: string;
  sourceKind: 'magnet' | 'url' | 'direct';
  /** File indexes picked by the sender; null/empty = whole torrent. */
  selection?: number[] | null;
  /** pending | downloading | done | failed | declined */
  state: 'pending' | 'downloading' | 'done' | 'failed' | 'declined';
  error?: string | null;
  createdAt: string;
  /** qBittorrent infohash (v1 hex) for magnet/url items handed to qBittorrent. */
  torrentHash?: string | null;
  /** Last qBittorrent progress snapshot (null until the first one lands). */
  progressPct?: number | null;
  dlSpeedBps?: number | null;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  progressAt?: string | null;
}

/** Progress snapshot reported to the relay so the SENDER can read it on demand. */
export interface DirectDownloadProgress {
  progressPct: number | null;
  dlSpeedBps: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
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
    // Fresh progress snapshot right away so the sender's first Check has data.
    await this.#refreshProgress().catch(() => {});
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

      const response = await client.request<{
        jobs: Array<{
          id: string;
          source: string;
          sourceKind: 'magnet' | 'url' | 'direct';
          selection?: number[] | null;
        }>;
      }>('GET', ApiRoutes.directJobs, undefined, { token });

      const known = new Set((await this.#loadQueue()).map((i) => i.id));
      for (const job of response.jobs) {
        if (known.has(job.id)) continue;
        await this.#appendLocal({
          id: job.id,
          source: job.source,
          sourceKind: job.sourceKind,
          selection: job.selection ?? null,
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

      // Receiver-side progress: refresh local qBittorrent snapshots and push
      // them to the relay. The SENDER only ever reads the stored snapshot on
      // demand — this push is the receiver's own cycle, not sender polling.
      await this.#refreshProgress();
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
        const wantsSelection = (item.selection?.length ?? 0) > 0;
        const tag = `vr_direct_${item.id}`;
        await qbit.client.addTorrent({
          urls: [item.source],
          savePath: s.clientDownloadDir,
          autoTMM: false,
          ...(wantsSelection ? { tags: [tag] } : {}),
        });
        // Remember the infohash so later polls can report % + speed.
        // Magnet: known upfront. .torrent URL: find it by the tag we just added.
        let hash = item.sourceKind === 'magnet' ? torrentHashFor(item.source) : null;
        item.torrentHash = hash;
        if (wantsSelection) {
          // Do not block the accept IPC / receive poll on slow metadata.
          void (async () => {
            const resolved = hash ?? (await this.#hashForTag(qbit, tag));
            if (!resolved) return;
            item.torrentHash = resolved;
            const queued = await this.#loadQueue();
            const stored = queued.find((entry) => entry.id === item.id);
            if (stored) {
              stored.torrentHash = resolved;
              await this.#saveQueue(queued);
            }
            await this.#applySelection(qbit, resolved, item.selection!);
            await qbit.client.removeTags([resolved], [tag]).catch(() => {});
          })().catch(() => {});
        }
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

  async #remoteReport(id: string, report: DirectDownloadProgress): Promise<void> {
    const token = this.relay.tokenForPolling();
    const client = this.relay.httpClient();
    if (!token || !client) return;
    await client.request('POST', ApiRoutes.directJobReport(id), report, { token });
  }

  /** Find a just-added .torrent URL's hash by its temporary tag. */
  async #hashForTag(qbit: QbitTorrentService, tag: string): Promise<string | null> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const infos = await qbit.client.getTorrents();
        const match = infos.find((info) => tagList(info.tags).includes(tag));
        if (match) return match.hash;
      } catch {
        /* keep polling */
      }
      if (Date.now() > deadline) return null;
      await sleep(1000);
    }
  }

  /**
   * Apply the sender's file indexes once metadata is available.
   * Unselected files get priority 0; selected files get normal priority.
   */
  async #applySelection(
    qbit: QbitTorrentService,
    hash: string,
    selection: number[],
  ): Promise<void> {
    const wanted = new Set(selection);
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const files = await qbit.client.getTorrentFiles(hash);
        if (files.length > 0) {
          const all = files.map((f) => f.index);
          const selected = all.filter((i) => wanted.has(i));
          const unselected = all.filter((i) => !wanted.has(i));
          await qbit.client.setFilePriority(hash, unselected, 0);
          await qbit.client.setFilePriority(hash, selected, 1);
          return;
        }
      } catch {
        /* metadata not ready yet */
      }
      if (Date.now() > deadline) return;
      await sleep(1000);
    }
  }

  /**
   * Refreshes qBittorrent progress for accepted items that carry a torrent
   * hash and aren't complete yet, persists the snapshot locally, and pushes
   * it to the relay for the sender's on-demand reads. Best-effort: qBittorrent
   * failures are swallowed — they must never break the receive poll.
   */
  async #refreshProgress(): Promise<void> {
    const items = await this.#loadQueue();
    const active = items.filter(
      (i) => i.torrentHash && i.state === 'done' && i.progressPct !== 100,
    );
    if (active.length === 0) return;
    const s = this.settings.get();
    if (!s.clientQbitUrl) return;
    const apiKey = this.secrets.get(SECRET_CLIENT_QBIT_KEY) ?? undefined;
    const qbit = new QbitTorrentService({ baseUrl: s.clientQbitUrl, apiKey });
    let infos: Array<{
      hash: string;
      progress: number;
      dlspeed: number;
      downloaded: number;
      total_size: number;
    }> = [];
    try {
      infos = await qbit.client.getTorrents(active.map((i) => i.torrentHash as string));
    } catch {
      return;
    }
    const byHash = new Map(infos.map((info) => [info.hash.toLowerCase(), info]));
    let changed = false;
    const reports: Array<{ id: string; report: DirectDownloadProgress }> = [];
    for (const item of active) {
      const info = byHash.get((item.torrentHash as string).toLowerCase());
      if (!info) continue;
      let progressPct = Math.round(info.progress * 1000) / 10;
      let downloadedBytes = info.downloaded;
      let totalBytes = info.total_size;
      // A selected subset never reaches 100% on the whole-torrent counter.
      if (item.selection?.length) {
        try {
          const wanted = new Set(item.selection);
          const files = await qbit.client.getTorrentFiles(info.hash);
          const chosen = files.filter((f) => wanted.has(f.index));
          if (chosen.length > 0) {
            totalBytes = chosen.reduce((sum, f) => sum + f.size, 0);
            downloadedBytes = chosen.reduce((sum, f) => sum + f.size * f.progress, 0);
            progressPct =
              totalBytes > 0
                ? Math.round((downloadedBytes / totalBytes) * 1000) / 10
                : 0;
          }
        } catch {
          /* fall back to whole-torrent progress */
        }
      }
      item.progressPct = progressPct;
      item.dlSpeedBps = info.dlspeed;
      item.downloadedBytes = downloadedBytes;
      item.totalBytes = totalBytes;
      item.progressAt = new Date().toISOString();
      changed = true;
      reports.push({
        id: item.id,
        report: {
          progressPct: item.progressPct,
          dlSpeedBps: item.dlSpeedBps,
          downloadedBytes: item.downloadedBytes,
          totalBytes: item.totalBytes,
        },
      });
    }
    if (changed) await this.#saveQueue(items);
    for (const r of reports) {
      await this.#remoteReport(r.id, r.report).catch(() => {});
    }
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

/** v1 infohash (lowercase hex) for magnet sources; null when unresolvable. */
function torrentHashFor(source: string): string | null {
  try {
    const parsed = parseTorrentSource(source);
    return parsed.kind === 'magnet' ? (parsed.infoHashV1 ?? null) : null;
  } catch {
    return null;
  }
}

function tagList(tags: string[] | string | undefined): string[] {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
