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

export interface DirectJob {
  id: string;
  source: string;
  sourceKind: 'magnet' | 'url' | 'direct';
  targetClientId: string;
  targetName: string;
  state: DirectJobState;
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

  async add(source: string, sourceKind: DirectJob['sourceKind'], targetClientId: string, targetName: string): Promise<DirectJob> {
    const jobs = await this.load();
    const now = new Date().toISOString();
    const job: DirectJob = {
      id: `dj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      source,
      sourceKind,
      targetClientId,
      targetName,
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

  async setState(id: string, state: Exclude<DirectJobState, 'queued'>): Promise<DirectJob | null> {
    const jobs = await this.load();
    const job = jobs.find((j) => j.id === id);
    if (!job || job.state !== 'queued') return null;
    job.state = state;
    job.updatedAt = new Date().toISOString();
    await this.save(jobs);
    return job;
  }
}
