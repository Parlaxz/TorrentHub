/**
 * Tiny JSON-backed JobRepository.
 * - One history file, capped at the last N (default 100) jobs by updatedAt.
 * - Atomic-ish writes: write to tmp file then rename over the target.
 * - NOT a crash-recovery engine: a torn file falls back to an empty history.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JobRecord } from "./types.ts";
import type { JobRepository as IJobRepository } from "./gateways.ts";

export interface JsonJobRepositoryOptions {
  /** Absolute path of the history JSON file. */
  filePath: string;
  maxRecords?: number;
}

interface HistoryFile {
  version: 1;
  jobs: JobRecord[];
}

export class JsonJobRepository implements IJobRepository {
  readonly #filePath: string;
  readonly #maxRecords: number;
  #cache: Map<string, JobRecord> | null = null;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(options: JsonJobRepositoryOptions) {
    this.#filePath = options.filePath;
    this.#maxRecords = options.maxRecords ?? 100;
  }

  async loadAll(): Promise<JobRecord[]> {
    await this.#ensureLoaded();
    return [...this.#cache!.values()];
  }

  async get(id: string): Promise<JobRecord | null> {
    await this.#ensureLoaded();
    return this.#cache!.get(id) ?? null;
  }

  async findByIdempotencyKey(key: string): Promise<JobRecord | null> {
    await this.#ensureLoaded();
    for (const record of this.#cache!.values()) {
      if (record.idempotencyKey === key || record.startIdempotencyKey === key) return record;
    }
    return null;
  }

  async upsert(record: JobRecord): Promise<void> {
    await this.#ensureLoaded();
    this.#cache!.set(record.id, record);
    // Serialize writes so concurrent stage updates never interleave file content.
    this.#writeChain = this.#writeChain.then(() => this.#flush()).catch(() => {});
    await this.#writeChain;
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#cache !== null) return;
    let jobs: JobRecord[] = [];
    try {
      const raw = await readFile(this.#filePath, "utf8");
      const parsed = JSON.parse(raw) as HistoryFile;
      if (parsed && Array.isArray(parsed.jobs)) jobs = parsed.jobs.filter(Boolean);
    } catch {
      jobs = []; // missing or unreadable history starts empty
    }
    this.#cache = new Map(jobs.map((job) => [job.id, job]));
  }

  async #flush(): Promise<void> {
    const jobs = [...this.#cache!.values()]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0))
      .slice(-this.#maxRecords);
    // Drop evicted records from cache so get() reflects the cap.
    const keep = new Set(jobs.map((job) => job.id));
    for (const id of [...this.#cache!.keys()]) {
      if (!keep.has(id)) this.#cache!.delete(id);
    }
    const payload: HistoryFile = { version: 1, jobs };
    await mkdir(dirname(this.#filePath), { recursive: true });
    const tmpPath = `${this.#filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    await rename(tmpPath, this.#filePath);
  }
}
