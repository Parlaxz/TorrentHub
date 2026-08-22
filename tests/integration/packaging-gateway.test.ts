/**
 * Integration seam A4 → A5: PackagingGatewayAdapter over the real packager.
 *
 * Covers: multifile explicit entries → STORE ZIP preserving the torrent's
 * logical hierarchy (no basename flattening) → only selected files packaged.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { PackagingGatewayAdapter } from '../../src/main/integration/packaging-gateway.ts';
import { readZipEntries } from '../helpers/zipInspect.ts';

describe('integration: A4 -> A5 packaging gateway', () => {
  it('packages multifile selections into a hierarchy-preserving STORE zip', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vr-pack-'));
    const downloadDir = path.join(root, 'download');
    const packageDir = path.join(root, 'package');
    await mkdir(path.join(downloadDir, 'Movie', 'sub'), { recursive: true });
    await mkdir(packageDir, { recursive: true });

    const fileA = path.join(downloadDir, 'Movie', 'movie.mkv');
    const fileB = path.join(downloadDir, 'Movie', 'sub', 'subs.srt');
    await writeFile(fileA, Buffer.alloc(4096, 7));
    await writeFile(fileB, Buffer.from('subtitle content'));

    const adapter = new PackagingGatewayAdapter();
    const result = await adapter.createZip({
      entries: [
        {
          absoluteSourcePath: fileA,
          archiveRelativePath: 'Movie/movie.mkv',
          sizeBytes: 4096,
          torrentFileIndex: 0,
        },
        {
          absoluteSourcePath: fileB,
          archiveRelativePath: 'Movie/sub/subs.srt',
          sizeBytes: 16,
          torrentFileIndex: 2,
        },
      ],
      outputZipPath: path.join(packageDir, 'My Torrent.zip'),
      abort: new AbortController().signal,
    });

    assert.equal(result.zipPath, path.join(packageDir, 'My Torrent.zip'));
    assert.equal(result.sizeBytes > 0, true);

    const entries = readZipEntries(result.zipPath);
    assert.deepEqual(
      entries.map((e) => e.name).sort(),
      ['Movie/movie.mkv', 'Movie/sub/subs.srt'],
    );
    // STORE method (0): container without recompression.
    for (const entry of entries) {
      assert.equal(entry.compressionMethod, 0, `entry ${entry.name} must be STORE`);
    }
    const movie = entries.find((e) => e.name === 'Movie/movie.mkv')!;
    assert.equal(movie.uncompressedSize, 4096);
    const subs = entries.find((e) => e.name === 'Movie/sub/subs.srt')!;
    assert.equal(subs.data.toString('utf8'), 'subtitle content');
  });

  it('passes a single-file selection through without creating an archive', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vr-pack1-'));
    const source = path.join(root, 'big.mkv');
    await writeFile(source, Buffer.alloc(1024, 1));

    const adapter = new PackagingGatewayAdapter();
    const result = await adapter.createZip({
      entries: [
        {
          absoluteSourcePath: source,
          archiveRelativePath: 'big.mkv',
          sizeBytes: 1024,
          torrentFileIndex: 0,
        },
      ],
      outputZipPath: path.join(root, 'unused.zip'),
      abort: new AbortController().signal,
    });

    assert.equal(result.zipPath, source);
    assert.equal(result.sizeBytes, 1024);
  });
});
