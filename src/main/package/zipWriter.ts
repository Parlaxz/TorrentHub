import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Transform, type TransformCallback } from 'node:stream';
import { ZipArchive } from 'archiver';
import { PackagingCancelledError, ZipStreamError } from './errors.ts';

const PROGRESS_THROTTLE_BYTES = 4 * 1024 * 1024;

export interface ZipEntryInput {
  sourcePath: string;
  archivePath: string;
}

export interface ZipWriterProgress {
  processedBytes: number;
  totalBytes: number;
  progress: number;
  throughputBytesPerSecond: number;
  filesCompleted: number;
}

export interface WriteStoreZipOptions {
  outputPath: string;
  entries: ZipEntryInput[];
  totalBytes: number;
  signal?: AbortSignal;
  onProgress?: (progress: ZipWriterProgress) => void;
}

class CountingTransform extends Transform {
  count = 0;
  private readonly onBytes: (delta: number) => void;

  constructor(onBytes: (delta: number) => void) {
    super();
    this.onBytes = onBytes;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.count += chunk.length;
    try {
      this.onBytes(chunk.length);
    } catch {
    }
    callback(null, chunk);
  }
}

export async function writeStoreZip(options: WriteStoreZipOptions): Promise<number> {
  const { outputPath, entries, totalBytes, signal, onProgress } = options;

  if (signal?.aborted) throw new PackagingCancelledError();

  const archive = new ZipArchive({ store: true });
  const output = createWriteStream(outputPath);

  let settled = false;
  let firstError: unknown;
  let processedBytes = 0;
  let filesCompleted = 0;
  let lastEmitted = 0;
  const startedAt = Date.now();

  const emitProgress = (force = false) => {
    if (!onProgress) return;
    if (!force && processedBytes - lastEmitted < PROGRESS_THROTTLE_BYTES) return;
    lastEmitted = processedBytes;
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    try {
      onProgress({
        processedBytes,
        totalBytes,
        progress: totalBytes > 0 ? Math.min(1, processedBytes / totalBytes) : 1,
        throughputBytesPerSecond: processedBytes / elapsedSeconds,
        filesCompleted,
      });
    } catch {
    }
  };

  const activeStreams = new Set<{ source: import('node:fs').ReadStream; counter: CountingTransform }>();

  const destroyAll = () => {
    archive.abort();
    for (const pair of activeStreams) {
      pair.source.destroy();
      pair.counter.destroy();
    }
    activeStreams.clear();
    output.destroy();
  };

  const settle = (error?: unknown) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    if (error !== undefined) {
      destroyAll();
      setImmediate(() => rejectPromise(error));
    } else {
      resolvePromise();
    }
  };

  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  completion.catch(() => {});

  function onAbort(): void {
    firstError = firstError ?? new PackagingCancelledError();
    settle(firstError);
  }

  archive.on('error', (error: unknown) => {
    firstError = firstError ?? new ZipStreamError('stream', { cause: error });
    settle(firstError);
  });
  archive.on('entry', () => {
    filesCompleted += 1;
    emitProgress(true);
  });
  output.on('error', (error: unknown) => {
    firstError = firstError ?? new ZipStreamError('stream', { cause: error });
    settle(firstError);
  });
  output.on('close', () => {
    settle(firstError);
  });
  signal?.addEventListener('abort', onAbort, { once: true });

  archive.pipe(output);

  try {
    for (const entry of entries) {
      if (signal?.aborted) throw new PackagingCancelledError();

      const source = createReadStream(entry.sourcePath);
      const counter = new CountingTransform((delta) => {
        processedBytes += delta;
        emitProgress();
      });
      const pair = { source, counter };
      activeStreams.add(pair);
      source.on('close', () => activeStreams.delete(pair));

      source.on('error', (error: unknown) => {
        firstError = firstError ?? new ZipStreamError('stream', { cause: error });
        settle(firstError);
      });

      archive.append(source.pipe(counter), { name: entry.archivePath });
    }

    emitProgress(true);

    void archive.finalize().catch((cause: unknown) => {
      firstError = firstError ?? new ZipStreamError('finalize', { cause });
      settle(firstError);
    });

    await completion;

    try {
      const handle = await open(outputPath, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
    }

    emitProgress(true);
    const info = await stat(outputPath);
    return info.size;
  } catch (error) {
    destroyAll();
    signal?.removeEventListener('abort', onAbort);
    throw error;
  }
}
