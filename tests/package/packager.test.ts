import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile, mkdir, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { crc32, readZipEntries } from '../helpers/zipInspect.ts';
import {
  InvalidPackagingRequestError,
  PackagingCancelledError,
  SelectedSourceMissingError,
  SourceNotRegularFileError,
  SourceSizeMismatchError,
  UnsafeArchivePathError,
  isZipRequired,
  packageSelectedFiles,
} from '../../src/main/package/index.ts';
import { InsufficientDiskSpaceError } from '../../src/main/storage/index.ts';
import type { SelectedFileEntry } from '../../src/main/package/index.ts';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `viking-a4-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function pseudoRandomBuffer(size: number, seed: number): Buffer {
  const buf = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    buf[i] = state & 0xff;
  }
  return buf;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rmSafe(dir);
  }
});

async function rmSafe(path: string): Promise<void> {
  await import('node:fs/promises')
    .then((m) => m.rm(path, { recursive: true, force: true }))
    .catch(() => {});
}

interface WrittenFile {
  entry: SelectedFileEntry;
  content: Buffer;
}

async function writeSource(
  srcDir: string,
  relativePath: string,
  archivePath: string,
  size: number,
  seed: number,
): Promise<WrittenFile> {
  const fullPath = join(srcDir, relativePath);
  await mkdir(join(fullPath, '..'), { recursive: true });
  const content = pseudoRandomBuffer(size, seed);
  await writeFile(fullPath, content);
  return {
    entry: {
      absoluteSourcePath: fullPath,
      archiveRelativePath: archivePath,
      sizeBytes: size,
    },
    content,
  };
}

describe('isZipRequired', () => {
  it('one file does not require a zip', () => {
    assert.equal(isZipRequired(1), false);
  });

  it('two or more files require a zip', () => {
    assert.equal(isZipRequired(2), true);
    assert.equal(isZipRequired(5), true);
  });

  it('force flag zips even a single file', () => {
    assert.equal(isZipRequired(1, true), true);
    assert.equal(isZipRequired(3, false), true);
  });
});

describe('packageSelectedFiles', () => {
  it('single selected file returns the original file without creating anything', async () => {
    const srcDir = await makeTempDir('src');
    const outDir = await makeTempDir('out');
    const { entry, content } = await writeSource(srcDir, 'only.bin', 'only.bin', 4096, 1);

    const outcome = await packageSelectedFiles({
      outputDirectory: outDir,
      baseName: 'job',
      files: [entry],
    });

    assert.equal(outcome.kind, 'single-file');
    if (outcome.kind !== 'single-file') return;
    assert.equal(outcome.sourcePath, entry.absoluteSourcePath);
    assert.equal(outcome.sizeBytes, 4096);
    assert.deepEqual(await readdir(outDir), []);
    assert.deepEqual(await readFile(entry.absoluteSourcePath), content);
  });

  it('forceZip packages a single file into a store zip', async () => {
    const srcDir = await makeTempDir('src');
    const outDir = await makeTempDir('out');
    const { entry, content } = await writeSource(srcDir, 'solo.mkv', 'solo.mkv', 8192, 2);

    const outcome = await packageSelectedFiles({
      outputDirectory: outDir,
      baseName: 'forced',
      files: [entry],
      forceZip: true,
    });

    assert.equal(outcome.kind, 'archive');
    if (outcome.kind !== 'archive') return;
    const entries = readZipEntries(outcome.archivePath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'solo.mkv');
    assert.equal(entries[0].compressionMethod, 0);
    assert.deepEqual(entries[0].data, content);
    assert.equal(crc32(content), entries[0].crc32);
  });

  it('packages exactly the explicit selection into a store zip with nested paths', async () => {
    const srcDir = await makeTempDir('src');
    const outDir = await makeTempDir('out');
    const keep1 = await writeSource(srcDir, join('data', 'keep1.bin'), 'video/movies/keep1.bin', 300 * 1024, 3);
    const keep2 = await writeSource(srcDir, join('data', 'keep2.bin'), 'subs/en.srt', 500 * 1024, 4);

    const strayPath = join(srcDir, 'data', 'ignore.bin');
    await writeFile(strayPath, pseudoRandomBuffer(12345, 99));
    const deselectedZero = join(srcDir, 'data', 'deselected.bin');
    await writeFile(deselectedZero, Buffer.alloc(0));

    const outcome = await packageSelectedFiles({
      outputDirectory: outDir,
      baseName: 'batch',
      files: [keep1.entry, keep2.entry],
    });

    assert.equal(outcome.kind, 'archive');
    if (outcome.kind !== 'archive') return;

    const entries = readZipEntries(outcome.archivePath);
    assert.deepEqual(
      entries.map((e) => e.name),
      ['video/movies/keep1.bin', 'subs/en.srt'],
    );
    for (const e of entries) {
      assert.equal(e.compressionMethod, 0, 'STORE mode expected');
    }
    assert.deepEqual(entries[0].data, keep1.content);
    assert.deepEqual(entries[1].data, keep2.content);
    assert.equal(crc32(keep1.content), entries[0].crc32);
    assert.equal(crc32(keep2.content), entries[1].crc32);

    assert.ok(existsSync(strayPath), 'stray deselected file must remain untouched');
    assert.ok(existsSync(deselectedZero), 'zero-byte deselected file must remain untouched');

    const info = await stat(outcome.archivePath);
    assert.equal(info.size, outcome.archiveSizeBytes);
  });

  it('leaves no .partial.zip behind after successful rename', async () => {
    const srcDir = await makeTempDir('src');
    const outDir = await makeTempDir('out');
    const f1 = await writeSource(srcDir, 'a.bin', 'a.bin', 64 * 1024, 5);
    const f2 = await writeSource(srcDir, 'b.bin', 'b.bin', 64 * 1024, 6);

    await packageSelectedFiles({
      outputDirectory: outDir,
      baseName: 'rename',
      files: [f1.entry, f2.entry],
    });

    const files = await readdir(outDir);
    assert.deepEqual(files.sort(), ['rename.zip']);
    assert.ok(!existsSync(join(outDir, 'rename.partial.zip')));
  });

  it('overwrites an existing final archive deterministically', async () => {
    const srcDir = await makeTempDir('src');
    const outDir = await makeTempDir('out');
    const f1 = await writeSource(srcDir, 'x.bin', 'x.bin', 16 * 1024, 7);
    const f2 = await writeSource(srcDir, 'y.bin', 'y.bin', 16 * 1024, 8);
    await writeFile(join(outDir, 'again.zip'), Buffer.from('stale junk'));

    const outcome = await packageSelectedFiles({
      outputDirectory: outDir,
      baseName: 'again',
      files: [f1.entry, f2.entry],
    });

    assert.equal(outcome.kind, 'archive');
    if (outcome.kind !== 'archive') return;
    const entries = readZipEntries(outcome.archivePath);
    assert.equal(entries.length, 2);
  });

  it('reports progress up to the exact byte total', async () => {
    const srcDir = await makeTempDir('src');
    const outDir = await makeTempDir('out');
    const f1 = await writeSource(srcDir, 'p1.bin', 'p1.bin', 300 * 1024, 9);
    const f2 = await writeSource(srcDir, 'p2.bin', 'p2.bin', 500 * 1024, 10);
    const total = 800 * 1024;

    const events: Array<{ processedBytes: number; progress: number; throughput: number; filesCompleted: number }> = [];
    await packageSelectedFiles({
      outputDirectory: outDir,
      baseName: 'progress',
      files: [f1.entry, f2.entry],
      onProgress: (p) => {
        events.push({
          processedBytes: p.processedBytes,
          progress: p.progress,
          throughput: p.throughputBytesPerSecond,
          filesCompleted: p.filesCompleted,
        });
      },
    });

    assert.ok(events.length >= 2, 'expected multiple progress events');
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].processedBytes >= events[i - 1].processedBytes);
    }
    const last = events[events.length - 1];
    assert.equal(last.processedBytes, total);
    assert.equal(last.progress, 1);
    assert.equal(last.filesCompleted, 2);
    assert.ok(events.some((e) => e.throughput > 0));
  });

  it('rejects traversal archive paths before writing anything', async () => {
    const srcDir = await makeTempDir('src');
    const outDir = await makeTempDir('out');
    const f1 = await writeSource(srcDir, 'safe.bin', 'safe.bin', 1024, 11);
    const evil: SelectedFileEntry = {
      absoluteSourcePath: f1.entry.absoluteSourcePath,
      archiveRelativePath: '../escape.bin',
      sizeBytes: 1024,
    };

    await assert.rejects(
      () =>
        packageSelectedFiles({
          outputDirectory: outDir,
          baseName: 'evil',
          files: [f1.entry, evil],
        }),
      UnsafeArchivePathError,
    );
    assert.deepEqual(await readdir(outDir), []);
  });

  it('fails with SelectedSourceMissingError and cleans up partials', async () => {
    const srcDir = await makeTempDir('src');
    const outDir = await makeTempDir('out');
    const ghost: SelectedFileEntry = {
      absoluteSourcePath: join(srcDir, 'ghost.bin'),
      archiveRelativePath: 'ghost.bin',
      sizeBytes: 10,
    };

    await assert.rejects(
      () =>
        packageSelectedFiles({ outputDirectory: outDir, baseName: 'missing', files: [ghost] }),
      SelectedSourceMissingError,
    );
    assert.deepEqual(await readdir(outDir), []);
  });

  it('detects source size mismatch', async () => {
    const srcDir = await makeTempDir('src');
    const outDir = await makeTempDir('out');
    const f1 = await writeSource(srcDir, 'mismatch.bin', 'mismatch.bin', 2048, 12);
    const wrong: SelectedFileEntry = { ...f1.entry, sizeBytes: 999 };

    await assert.rejects(
      () =>
        packageSelectedFiles({ outputDirectory: outDir, baseName: 'mismatch', files: [wrong] }),
      (error: unknown) => {
        assert.ok(error instanceof SourceSizeMismatchError);
        assert.equal(error.expectedBytes, 999);
        assert.equal(error.actualBytes, 2048);
        return true;
      },
    );
  });

  it('refuses symlinks as selected sources instead of following them', async (t) => {
    const srcDir = await makeTempDir('src');
    const outDir = await makeTempDir('out');
    const target = join(srcDir, 'real.bin');
    await writeFile(target, pseudoRandomBuffer(512, 13));
    const link = join(srcDir, 'link.bin');
    try {
      await symlink(target, link, 'file');
    } catch {
      t.skip('symlink creation not permitted on this platform/account');
      return;
    }

    await assert.rejects(
      () =>
        packageSelectedFiles({
          outputDirectory: outDir,
          baseName: 'links',
          files: [
            { absoluteSourcePath: link, archiveRelativePath: 'link.bin', sizeBytes: 512 },
          ],
        }),
      SourceNotRegularFileError,
    );
  });

  it('blocks packaging start on fresh insufficient-space check without touching sources', async () => {
    const srcDir = await makeTempDir('src');
    const outDir = await makeTempDir('out');
    const f1 = await writeSource(srcDir, 'big1.bin', 'big1.bin', 64 * 1024, 14);
    const f2 = await writeSource(srcDir, 'big2.bin', 'big2.bin', 64 * 1024, 15);

    await assert.rejects(
      () =>
        packageSelectedFiles({
          outputDirectory: outDir,
          baseName: 'nospace',
          files: [f1.entry, f2.entry],
          storageProbe: async () => ({ freeBytes: 1024 }),
        }),
      (error: unknown) => {
        assert.ok(error instanceof InsufficientDiskSpaceError);
        assert.equal(error.phase, 'packaging-start');
        assert.equal(error.freeBytes, 1024);
        assert.ok(error.requiredBytes > 2 * 1024 ** 3);
        assert.equal(error.deficitBytes, error.requiredBytes - 1024);
        return true;
      },
    );

    assert.deepEqual(await readdir(outDir), [], 'no archive artifacts may be created');
    assert.ok(existsSync(f1.entry.absoluteSourcePath));
    assert.ok(existsSync(f2.entry.absoluteSourcePath));
  });

  it('cancels mid-stream, deletes the partial, and leaves sources intact', async () => {
    const srcDir = await makeTempDir('src');
    const outDir = await makeTempDir('out');
    const big = await writeSource(srcDir, 'huge.bin', 'huge.bin', 32 * 1024 * 1024, 16);
    const controller = new AbortController();

    await assert.rejects(
      () =>
        packageSelectedFiles({
          outputDirectory: outDir,
          baseName: 'cancel',
          files: [big.entry],
          forceZip: true,
          signal: controller.signal,
          onProgress: (p) => {
            if (p.processedBytes > 1024 * 1024) controller.abort();
          },
        }),
      PackagingCancelledError,
    );

    const leftovers = (await readdir(outDir)).filter((f) => f.endsWith('.zip'));
    assert.deepEqual(leftovers, [], 'no partial or final zip may survive cancellation');
    assert.ok(existsSync(big.entry.absoluteSourcePath), 'source must remain untouched');
  });

  it('rejects empty selections and unusable base names', async () => {
    const outDir = await makeTempDir('out');
    await assert.rejects(
      () =>
        packageSelectedFiles({
          outputDirectory: outDir,
          baseName: 'empty',
          files: [],
        }),
      InvalidPackagingRequestError,
    );
    const srcDir = await makeTempDir('src');
    const f1 = await writeSource(srcDir, 'z.bin', 'z.bin', 8, 17);
    const f2 = await writeSource(srcDir, 'w.bin', 'w.bin', 8, 18);
    await assert.rejects(
      () =>
        packageSelectedFiles({
          outputDirectory: outDir,
          baseName: '..',
          files: [f1.entry, f2.entry],
        }),
      InvalidPackagingRequestError,
    );
  });
});
