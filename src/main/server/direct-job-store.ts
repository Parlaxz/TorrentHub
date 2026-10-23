/**
 * DirectJobStore — persisted queue of download jobs the server user has sent
 * to paired clients ("friend mode"). The friend's app polls for jobs targeted
 * at its clientId, then accepts (downloads locally) or declines.
 *
 * JSON-backed like job history; small scale by design.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type DirectJobState = 'queued' | 'accepted' | 'declined';

/** Last progress snapshot reported by the RECEIVING client (its own qBittorrent). */
export interface DirectJobProgress {
  progressPct: number | null;
  dlSpeedBps: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  updatedAt: string;
}

export interface DirectJob {
  id: string;
  source: string;
  sourceKind: 'magnet' | 'url' | 'direct';
  targetClientId: string;
  targetName: string;
  /** Who sent it: the server user or another paired client. */
  fromClientId: string;
  fromName: string;
  state: DirectJobState;
  /** Receiver-reported download progress; null until the first report lands. */
  progress?: DirectJobProgress | null;
  createdAt: string;
  updatedAt: string;
}

interface StoreFile {
  version: 1;
  jobs: DirectJob[];
}

export class DirectJobStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  private async load(): Promise<DirectJob[]> {
    try {
      const raw = await readFile(this.#filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoreFile;
      return parsed.version === 1 && Array.isArray(parsed.jobs) ? parsed.jobs : [];
    } catch {
      return [];
    }
  }

  private async save(jobs: DirectJob[]): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    const file: StoreFile = { version: 1, jobs };
    await writeFile(this.#filePath, JSON.stringify(file, null, 2), 'utf8');
  }

  async add(
    source: string,
    sourceKind: DirectJob['sourceKind'],
    targetClientId: string,
    targetName: string,
    from: { clientId: string; name: string } = { clientId: 'server', name: 'Server' },
  ): Promise<DirectJob> {
    const jobs = await this.load();
    const now = new Date().toISOString();
    const job: DirectJob = {
      id: `dj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      source,
      sourceKind,
      targetClientId,
      targetName,
      fromClientId: from.clientId,
      fromName: from.name,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    jobs.push(job);
    await this.save(jobs);
    return job;
  }

  async listAll(): Promise<DirectJob[]> {
    return (await this.load()).slice().reverse(); // newest first
  }

  async queuedFor(clientId: string): Promise<DirectJob[]> {
    return (await this.load()).filter((j) => j.targetClientId === clientId && j.state === 'queued');
  }

  /** Jobs this client sent (newest first) — the sender's on-demand status view. */
  async sentBy(clientId: string): Promise<DirectJob[]> {
    return (await this.load())
      .filter((j) => j.fromClientId === clientId)
      .slice()
      .reverse(); // newest first
  }

  async getById(id: string): Promise<DirectJob | null> {
    return (await this.load()).find((j) => j.id === id) ?? null;
  }

  async setState(id: string, state: Exclude<DirectJobState, 'queued'>): Promise<DirectJob | null> {
    const jobs = await this.load();
    const job = jobs.find((j) => j.id === id);
    if (!job || job.state !== 'queued') return null;
    job.state = state;
    job.updatedAt = new Date().toISOString();
    await this.save(jobs);
    return job;
  }

  /**
   * Records a download-progress snapshot for a job. ONLY the receiving
   * client (targetClientId) may report — anyone else gets null (the route
   * maps that to 404, so there is no cross-tenant oracle). Numbers are
   * clamped/sanitized; garbage becomes null rather than a throw.
   */
  async reportProgress(
    id: string,
    report: {
      progressPct?: number | null;
      dlSpeedBps?: number | null;
      downloadedBytes?: number | null;
      totalBytes?: number | null;
    },
    reporterClientId: string,
  ): Promise<DirectJob | null> {
    const jobs = await this.load();
    const job = jobs.find((j) => j.id === id);
    if (!job || job.targetClientId !== reporterClientId) return null;
    job.progress = {
      progressPct: clampPct(report.progressPct),
      dlSpeedBps: clampNonNegativeInt(report.dlSpeedBps),
      downloadedBytes: clampNonNegativeInt(report.downloadedBytes),
      totalBytes: clampNonNegativeInt(report.totalBytes),
      updatedAt: new Date().toISOString(),
    };
    await this.save(jobs);
    return job;
  }
}

function clampPct(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function clampNonNegativeInt(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}
