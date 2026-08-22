/**
 * Integration seam A3 → A5: VikingGatewayAdapter over the local mock Viking
 * multipart server. Covers: byte progress → final URL/hash mapping →
 * check-file verification.
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { VikingClient } from '../../src/main/viking/index.ts';
import { VikingGatewayAdapter } from '../../src/main/integration/viking-gateway.ts';
import { createMockViking } from '../viking/helpers/mock-server.ts';

describe('integration: A3 -> A5 viking gateway', () => {
  it('uploads with monotonic byte progress and returns the final URL', async () => {
    const viking = await createMockViking({ partSize: 64 * 1024 });
    try {
      const root = await mkdtemp(path.join(tmpdir(), 'vr-viking-'));
      const file = path.join(root, 'movie.mkv');
      const size = 200 * 1024;
      await writeFile(file, Buffer.alloc(size, 9));

      const client = new VikingClient({ baseUrl: viking.url, concurrency: 2 });
      const adapter = new VikingGatewayAdapter(() => client);

      const progressEvents: Array<{ uploaded: number; total: number }> = [];
      const result = await adapter.upload({
        filePath: file,
        fileName: 'movie.mkv',
        sizeBytes: size,
        abort: new AbortController().signal,
        onProgress: (p) => progressEvents.push({ uploaded: p.uploadedBytes, total: p.totalBytes }),
      });

      assert.equal(result.url, 'https://vikingfile.com/f/TPRSfLvcIu');
      assert.equal(result.sha256, 'TPRSfLvcIu');
      assert.equal(result.sizeBytes, size);

      // Byte-accurate progress: monotonic, ends exactly at the file size.
      assert.ok(progressEvents.length >= 1);
      for (let i = 1; i < progressEvents.length; i += 1) {
        assert.ok(progressEvents[i].uploaded >= progressEvents[i - 1].uploaded);
      }
      assert.equal(progressEvents[progressEvents.length - 1].uploaded, size);
      assert.equal(progressEvents[progressEvents.length - 1].total, size);

      // check-file verification capability works against the returned hash.
      assert.equal(await adapter.verify(result), true);
    } finally {
      await viking.close();
    }
  });
});
