/**
 * Integration: final successful mock E2E (scenario 10).
 *
 * magnet metadata → selection → job → simulated qBittorrent download
 * (mocked WebUI, real files materialized at the derived layout) → REAL small
 * STORE ZIP (A4 packager) → mocked Viking multipart server → complete URL →
 * guarded cleanup. No paid/large real torrent involved.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createMockFetch, jsonResponse, parseForm, textResponse } from '../qbit/mock.ts';
import { HASH, fetchMetadataFull, fileList, torrentInfo } from '../qbit/fixtures.ts';
import { QbitTorrentService } from '../../src/main/qbit/service.ts';
import { QbitTorrentGateway } from '../../src/main/integration/qbit-gateway.ts';
import { PackagingGatewayAdapter } from '../../src/main/integration/packaging-gateway.ts';
import { StoragePolicyGateway } from '../../src/main/integration/storage-gateway.ts';
import { HttpDirectDownloadGateway } from '../../src/main/integration/direct-gateway.ts';
import { VikingClient } from '../../src/main/viking/index.ts';
import { VikingGatewayAdapter } from '../../src/main/integration/viking-gateway.ts';
import { createMockViking } from '../viking/helpers/mock-server.ts';
import {
  FsWorkspaceGateway,
  JobEngine,
  JsonJobRepository,
  resolveConfig,
} from '../../src/main/jobs/index.ts';

const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Movie%202024`;

describe('integration: full mock E2E pipeline', () => {
  it('runs metadata -> selection -> download -> STORE ZIP -> viking -> URL', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vr-e2e-'));
    const jobsRoot = path.join(root, 'jobs');
    const historyFile = path.join(root, 'history.json');

    // ---- mocked qBittorrent WebUI with stateful progress ----
    let added = false;
    let savePath = '';
    let ownershipTag = '';
    let pollCount = 0;
    const priorities = [1, 1, 1];
    const mock = createMockFetch(async (req) => {
      if (req.path === '/api/v2/app/webapiVersion') return textResponse('2.11.9');
      if (req.path === '/api/v2/app/version') return textResponse('v5.2.0');
      if (req.path === '/api/v2/torrents/fetchMetadata') return jsonResponse(fetchMetadataFull());
      if (req.path === '/api/v2/torrents/add') {
        const form = parseForm(req.body);
        savePath = form.savepath ?? '';
        ownershipTag = form.category ?? '';
        added = true;
        return textResponse('Ok.');
      }
      if (req.path === '/api/v2/torrents/info') {
        if (!added) return jsonResponse([]);
        return jsonResponse([
          torrentInfo({
            tags: [ownershipTag],
            category: ownershipTag,
            save_path: savePath ? savePath + '/' : '',
            content_path: savePath ? path.join(savePath, 'Movie 2024') : '',
          }),
        ]);
      }
      if (req.path === '/api/v2/torrents/files') {
        pollCount += 1;
        // Second poll onward: selected files complete; materialize real files
        // at the derived layout with EXACT declared sizes so packaging's
        // lstat validation passes.
        if (pollCount >= 2 && savePath) {
          await materialize(savePath);
        }
        const progress = pollCount >= 2 ? [1, 1, 0] : [0, 0, 0];
        return jsonResponse(fileList(priorities, progress));
      }
      if (req.path === '/api/v2/torrents/filePrio') {
        const form = parseForm(req.body);
        const ids = form.id.split('|').map((n) => Number.parseInt(n, 10));
        const prio = Number.parseInt(form.priority, 10);
        for (const id of ids) priorities[id] = prio;
        return textResponse('');
      }
      if (req.path === '/api/v2/torrents/start' || req.path === '/api/v2/torrents/stop') {
        return textResponse('');
      }
      if (req.path === '/api/v2/torrents/delete') {
        deletedHashes.push(parseForm(req.body).hashes);
        return textResponse('');
      }
      if (
        req.path.endsWith('/createCategory') ||
        req.path.endsWith('/createTags') ||
        req.path.endsWith('/addTags') ||
        req.path.endsWith('/setCategory') ||
        req.path.endsWith('/removeTags')
      ) {
        return textResponse('');
      }
      throw new Error('unexpected path ' + req.path);
    });

    const deletedHashes: string[] = [];
    const qbit = new QbitTorrentService({ baseUrl: 'http://localhost:8080', apiKey: 'k', fetchImpl: mock.fetchImpl });
    const vikingMock = await createMockViking({ partSize: 64 * 1024 });
    const vikingClient = new VikingClient({ baseUrl: vikingMock.url, concurrency: 2 });

    const engine = new JobEngine(
      {
        torrent: new QbitTorrentGateway(() => qbit),
        direct: new HttpDirectDownloadGateway(),
        viking: new VikingGatewayAdapter(() => vikingClient),
        packaging: new PackagingGatewayAdapter(),
        storage: new StoragePolicyGateway(),
        workspace: new FsWorkspaceGateway(jobsRoot),
        repository: new JsonJobRepository({ filePath: historyFile }),
      },
      resolveConfig({
        jobsRoot,
        historyFilePath: historyFile,
        pollIntervalMs: 15,
      }),
    );

    // Crash policy: sweep runs once before jobs are exposed.
    assert.equal(await engine.startupSweep(), 0);

    let draftId = '';
    try {
      const draft = await engine.createIntake(MAGNET);
      draftId = draft.id;
      assert.equal(draft.state, 'awaiting_selection');

      const record = await engine.commitSelection(draft.id, [1, 0]);
      assert.equal(record.zipRequired, true);
      await engine.whenIdle();

      const job = await engine.getJob(record.id);
      assert.equal(
        job.state,
        'complete',
        `expected complete, got ${job.state} (${job.error?.message})`,
      );
      assert.ok(job.result?.url.startsWith('https://vikingfile.com/f/'));

      // The uploaded artifact was a REAL zip of exactly the selected files.
      const completeForm = vikingMock.state.completeRequests[0];
      assert.equal(completeForm.name, 'Movie 2024.zip');

      // Cleanup: owned torrent deleted WITH data, zip removed.
      assert.deepEqual(deletedHashes, [HASH]);
      assert.equal(existsSync(job.zipPath ?? ''), false, 'zip must be cleaned up');

      // History persisted the completed record.
      const fs = await import('node:fs/promises');
      const persisted = JSON.parse(await fs.readFile(historyFile, 'utf8'));
      const persistedJob = persisted.jobs.find((j: { id: string }) => j.id === record.id);
      assert.equal(persistedJob.state, 'complete');
      assert.equal(persistedJob.result.url, job.result!.url);
    } catch (error) {
      // Never leave the poll loop / mock server keeping the process alive.
      await engine.cancel(draftId, { cleanup: true }).catch(() => undefined);
      throw error;
    } finally {
      await vikingMock.close();
    }
  });
});

async function materialize(savePath: string): Promise<void> {
  const base = path.dirname(path.join(savePath, 'Movie 2024'));
  // Sizes MUST equal the torrent metadata declarations (A4 validates lstat).
  await mkdir(path.join(base, 'Movie'), { recursive: true });
  await writeFile(path.join(base, 'Movie', 'movie.mkv'), Buffer.alloc(1_000_000, 1));
  await writeFile(path.join(base, 'Movie', 'sample.mkv'), Buffer.alloc(50_000, 2));
}
