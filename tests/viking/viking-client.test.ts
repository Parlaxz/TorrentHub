import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { VikingClient, VikingError, computeParts } from '../../src/main/viking/index'
import type { UploadProgress, UploadSourceFile, VikingUploadResult } from '../../src/main/viking/types'
import { createMockViking } from './helpers/mock-server'
import type { MockViking, MockVikingOptions } from './helpers/mock-server'
import {
  cleanupTempFiles,
  fileUnchanged,
  patternedBuffer,
  writeTempFile,
} from './helpers/tmp-files'
import type { TempFile } from './helpers/tmp-files'

const PART = 16 * 1024

function makeSource(file: TempFile): UploadSourceFile {
  return { path: file.path, size: file.size, name: 'source.bin' }
}

function extractCompletedParts(form: Record<string, string>): Array<{ partNumber: number; etag: string }> {
  const byIndex = new Map<number, { partNumber?: number; etag?: string }>()
  for (const [k, v] of Object.entries(form)) {
    const m = /^parts\[(\d+)\]\[(PartNumber|ETag)\]$/.exec(k)
    if (!m) continue
    const idx = Number(m[1])
    const entry = byIndex.get(idx) ?? {}
    if (m[2] === 'PartNumber') entry.partNumber = Number(v)
    else entry.etag = v
    byIndex.set(idx, entry)
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, e]) => {
      assert.ok(e.partNumber !== undefined && e.etag !== undefined, `incomplete parts entry at index`)
      return { partNumber: e.partNumber, etag: e.etag }
    })
}

interface Harness {
  mock: MockViking
  client: VikingClient
  files: TempFile[]
}

async function withHarness(
  opts: MockVikingOptions,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const mock = await createMockViking(opts)
  const client = new VikingClient({
    baseUrl: mock.url,
    backoff: { baseDelayMs: 10, maxDelayMs: 60 },
    timeoutMs: opts.stallPart ? 150 : 5_000,
  })
  const files: TempFile[] = []
  try {
    await fn({ mock, client, files })
  } finally {
    await cleanupTempFiles(files)
    await mock.close()
  }
}

describe('computeParts', () => {
  it('splits exact multiples into full contiguous ranges', () => {
    const ranges = computeParts(30_720, 6_144)
    assert.equal(ranges.length, 5)
    let next = 0
    for (const r of ranges) {
      assert.equal(r.start, next)
      assert.equal(r.end, r.start + 6_144 - 1)
      next = r.end + 1
    }
    assert.equal(next, 30_720)
  })

  it('bounds the last partial range', () => {
    const ranges = computeParts(10_000, 4_000)
    assert.deepEqual(ranges, [
      { start: 0, end: 3_999 },
      { start: 4_000, end: 7_999 },
      { start: 8_000, end: 9_999 },
    ])
  })

  it('rejects invalid sizes', () => {
    assert.throws(() => computeParts(0, 100), /Invalid file size/)
    assert.throws(() => computeParts(100, 0), /Invalid part size/)
  })
})

describe('createMultipartSession parsing', () => {
  it('accepts a well-formed session response', async () => {
    await withHarness({ partSize: PART }, async ({ mock, client, files }) => {
      const file = await writeTempFile('session-ok', patternedBuffer(PART))
      files.push(file)
      const session = await client.createMultipartSession(makeSource(file))
      assert.equal(session.uploadId, 'MOCKUPLOADID123')
      assert.equal(session.key, 'mockkey')
      assert.equal(session.partSize, PART)
      assert.equal(session.numberParts, 1)
      assert.equal(session.urls.length, 1)
      assert.ok(session.urls[0].startsWith(`${mock.url}/put/1?`))
    })
  })

  it('fails clearly on missing fields', async () => {
    await withHarness(
      { sessionOverride: () => ({ key: 'k', partSize: 10, numberParts: 1, urls: ['http://x/1'] }) },
      async ({ client, files }) => {
        const file = await writeTempFile('session-bad1', patternedBuffer(10))
        files.push(file)
        await assert.rejects(
          () => client.createMultipartSession(makeSource(file)),
          (err: VikingError) => err.kind === 'malformed_response' && /uploadId/.test(err.message),
        )
      },
    )
  })

  it('fails when urls length does not match numberParts', async () => {
    await withHarness(
      {
        sessionOverride: () => ({
          uploadId: 'u',
          key: 'k',
          partSize: 10,
          numberParts: 2,
          urls: ['http://x/1'],
        }),
      },
      async ({ client, files }) => {
        const file = await writeTempFile('session-bad2', patternedBuffer(20))
        files.push(file)
        await assert.rejects(
          () => client.createMultipartSession(makeSource(file)),
          (err: VikingError) => err.kind === 'malformed_response' && /urls/.test(err.message),
        )
      },
    )
  })

  it('fails on invalid partSize and non-JSON bodies', async () => {
    await withHarness(
      { sessionOverride: () => ({ uploadId: 'u', key: 'k', partSize: 0, numberParts: 1, urls: ['http://x/1'] }) },
      async ({ client, files }) => {
        const file = await writeTempFile('session-bad3', patternedBuffer(10))
        files.push(file)
        await assert.rejects(
          () => client.createMultipartSession(makeSource(file)),
          (err: VikingError) => err.kind === 'malformed_response' && /partSize/.test(err.message),
        )
      },
    )
    await withHarness({ sessionOverride: () => '<html>gateway error</html>' }, async ({ client, files }) => {
      const file = await writeTempFile('session-bad4', patternedBuffer(10))
      files.push(file)
      await assert.rejects(
        () => client.createMultipartSession(makeSource(file)),
        (err: VikingError) => err.kind === 'malformed_response',
      )
    })
  })

  it('maps HTTP error status to a retryable http_status error', async () => {
    await withHarness(
      { sessionStatus: 503, sessionOverride: () => ({ error: 'overloaded' }) },
      async ({ client, files }) => {
        const file = await writeTempFile('session-503', patternedBuffer(10))
        files.push(file)
        await assert.rejects(
          () => client.createMultipartSession(makeSource(file)),
          (err: VikingError) =>
            err.kind === 'http_status' && err.statusCode === 503 && err.retryable === true,
        )
      },
    )
  })
})

describe('multipart upload happy path', () => {
  it('uploads exact byte ranges, captures ETags, completes, and maps the result', async () => {
    await withHarness({ partSize: PART }, async ({ mock, client, files }) => {
      const content = patternedBuffer(PART * 3 + 1234)
      const file = await writeTempFile('happy', content)
      files.push(file)

      let lastProgress: UploadProgress | undefined
      const result: VikingUploadResult = await client.uploadFile(makeSource(file), {
        onProgress: (p) => {
          lastProgress = p
        },
      })

      assert.equal(result.url, 'https://vikingfile.com/f/TPRSfLvcIu')
      assert.equal(result.hash, 'TPRSfLvcIu')
      assert.equal(result.name, 'source.bin')
      assert.equal(result.size, content.length)

      // Byte-exact range reassembly.
      const expectedParts = Math.ceil(content.length / PART)
      assert.equal(mock.state.partBodies.size, expectedParts)
      const reassembled = Buffer.concat(
        Array.from({ length: expectedParts }, (_, i) => mock.state.partBodies.get(i + 1)!),
      )
      assert.ok(reassembled.equals(content))
      for (let i = 0; i < expectedParts; i += 1) {
        const expectedLen = Math.min(PART, content.length - i * PART)
        assert.equal(mock.state.partBodies.get(i + 1)!.length, expectedLen)
      }

      // Complete-upload payload structure.
      assert.equal(mock.state.completeRequests.length, 1)
      const form = mock.state.completeRequests[0]
      assert.equal(form['key'], 'mockkey')
      assert.equal(form['uploadId'], 'MOCKUPLOADID123')
      assert.equal(form['name'], 'source.bin')
      assert.equal(form['user'], '')
      const submitted = extractCompletedParts(form)
      assert.equal(submitted.length, expectedParts)
      submitted.forEach((p, i) => {
        assert.equal(p.partNumber, i + 1)
        assert.equal(p.etag, mock.state.etagsIssued.get(i + 1))
      })

      // Final progress reflects every byte.
      assert.ok(lastProgress)
      assert.equal(lastProgress.uploadedBytes, content.length)
      assert.equal(lastProgress.progress, 1)
      assert.equal(lastProgress.completedParts, expectedParts)
      assert.equal(lastProgress.totalParts, expectedParts)
    })
  })

  it('sends the configured user hash as `user`', async () => {
    await withHarness({ partSize: PART }, async ({ mock, files }) => {
      const clientWithUser = new VikingClient({
        baseUrl: mock.url,
        userHash: 'user-hash-xyz',
        backoff: { baseDelayMs: 10 },
      })
      const file = await writeTempFile('userhash', patternedBuffer(PART))
      files.push(file)
      await clientWithUser.uploadFile(makeSource(file))
      assert.equal(mock.state.completeRequests[0]['user'], 'user-hash-xyz')
    })
  })
})

describe('concurrency bound', () => {
  it('never exceeds 3 simultaneous part uploads and does run in parallel', async () => {
    await withHarness({ partSize: PART, partDelayMs: 80 }, async ({ mock, client, files }) => {
      const file = await writeTempFile('conc', patternedBuffer(PART * 7))
      files.push(file)
      await client.uploadFile(makeSource(file))
      assert.ok(
        mock.state.maxActiveParts <= 3,
        `max concurrent parts ${mock.state.maxActiveParts} exceeded bound`,
      )
      assert.ok(mock.state.maxActiveParts >= 2, 'parts were not uploaded in parallel')
    })
  })
})

describe('byte progress accounting', () => {
  it('reports monotonic byte progress with speed and ETA', async () => {
    await withHarness({ partSize: PART, partDelayMs: 40 }, async ({ client, files }) => {
      const content = patternedBuffer(PART * 6)
      const file = await writeTempFile('progress', content)
      files.push(file)
      const events: UploadProgress[] = []
      await client.uploadFile(makeSource(file), {
        progressIntervalMs: 5,
        onProgress: (p) => events.push(p),
      })
      assert.ok(events.length >= 2, `expected multiple progress events, got ${events.length}`)
      for (let i = 1; i < events.length; i += 1) {
        assert.ok(events[i].uploadedBytes >= events[i - 1].uploadedBytes, 'progress went backwards')
      }
      const first = events[0]
      const last = events[events.length - 1]
      assert.ok(first.uploadedBytes < content.length, 'no intermediate progress observed')
      assert.equal(last.uploadedBytes, content.length)
      assert.equal(last.progress, 1)
      assert.ok(last.bytesPerSecond >= 0)
      assert.ok(last.etaSeconds === null || last.etaSeconds >= 0)
      assert.ok(events.some((e) => e.progress > 0 && e.progress < 1))
    })
  })
})

describe('retry policy', () => {
  it('retries transient 5xx failures and still counts exact bytes', async () => {
    await withHarness(
      { partSize: PART, failPart: { partNumber: 2, times: 2, status: 500 } },
      async ({ mock, client, files }) => {
        const content = patternedBuffer(PART * 3)
        const file = await writeTempFile('retry5xx', content)
        files.push(file)
        const result = await client.uploadFile(makeSource(file))
        assert.equal(mock.state.partAttempts.get(2), 3)
        assert.equal(result.hash, 'TPRSfLvcIu')
        const reassembled = Buffer.concat([1, 2, 3].map((i) => mock.state.partBodies.get(i)!))
        assert.ok(reassembled.equals(content))
      },
    )
  })

  it('retries connection resets', async () => {
    await withHarness(
      { partSize: PART, resetPart: { partNumber: 1, times: 1 } },
      async ({ mock, client, files }) => {
        const file = await writeTempFile('reset', patternedBuffer(PART * 2))
        files.push(file)
        await client.uploadFile(makeSource(file))
        assert.equal(mock.state.partAttempts.get(1), 2)
      },
    )
  })

  it('retries stalled requests that hit the stall timeout', async () => {
    await withHarness(
      { partSize: PART, stallPart: { partNumber: 1, times: 1, ms: 800 } },
      async ({ mock, client, files }) => {
        const file = await writeTempFile('stall', patternedBuffer(PART))
        files.push(file)
        await client.uploadFile(makeSource(file))
        assert.equal(mock.state.partAttempts.get(1), 2)
      },
    )
  })

  it('honors Retry-After on 429', async () => {
    await withHarness(
      { partSize: PART, failPart: { partNumber: 1, times: 1, status: 429, retryAfter: '0' } },
      async ({ mock, client, files }) => {
        const file = await writeTempFile('r429', patternedBuffer(PART))
        files.push(file)
        await client.uploadFile(makeSource(file))
        assert.equal(mock.state.partAttempts.get(1), 2)
      },
    )
  })

  it('does not endlessly retry permanent 4xx errors', async () => {
    await withHarness(
      { partSize: PART, failPart: { partNumber: 2, times: 99, status: 400 } },
      async ({ mock, client, files }) => {
        const file = await writeTempFile('perm400', patternedBuffer(PART * 3))
        files.push(file)
        await assert.rejects(
          () => client.uploadFile(makeSource(file)),
          (err: VikingError) =>
            err.kind === 'http_status' &&
            err.statusCode === 400 &&
            err.retryable === false &&
            err.partNumber === 2,
        )
        assert.equal(mock.state.partAttempts.get(2), 1)
        assert.equal(mock.state.completeRequests.length, 0)
        assert.ok(await fileUnchanged(file), 'source file was modified after failure')
      },
    )
  })

  it('gives up after maxAttempts on persistent transient errors', async () => {
    await withHarness(
      { partSize: PART, failPart: { partNumber: 1, times: 99, status: 500 } },
      async ({ mock, client, files }) => {
        const file = await writeTempFile('perm5xx', patternedBuffer(PART))
        files.push(file)
        await assert.rejects(() => client.uploadFile(makeSource(file)))
        assert.equal(mock.state.partAttempts.get(1), 4)
        assert.ok(await fileUnchanged(file))
      },
    )
  })
})

describe('cancellation', () => {
  it('aborts promptly mid-upload and leaves the source untouched', async () => {
    await withHarness({ partSize: PART, partDelayMs: 200 }, async ({ mock, client, files }) => {
      const file = await writeTempFile('cancel', patternedBuffer(PART * 8))
      files.push(file)
      const ac = new AbortController()
      setTimeout(() => ac.abort(), 120)
      await assert.rejects(
        () => client.uploadFile(makeSource(file), { signal: ac.signal }),
        (err: VikingError) => err.kind === 'aborted' && err.retryable === false,
      )
      assert.equal(mock.state.completeRequests.length, 0)
      assert.ok(await fileUnchanged(file))
    })
  })

  it('rejects immediately when the signal is already aborted', async () => {
    await withHarness({ partSize: PART }, async ({ mock, client, files }) => {
      const file = await writeTempFile('preabort', patternedBuffer(PART))
      files.push(file)
      const ac = new AbortController()
      ac.abort()
      await assert.rejects(
        () => client.uploadFile(makeSource(file), { signal: ac.signal }),
        (err: VikingError) => err.kind === 'aborted',
      )
      assert.equal(mock.state.sessionRequests, 0)
    })
  })
})

describe('verifyUploadedFile (check-file)', () => {
  it('maps a positive check-file response', async () => {
    await withHarness(
      { checkFileResponse: { exist: true, name: 'remote.bin', size: 42 } },
      async ({ mock, client }) => {
        const check = await client.verifyUploadedFile('HASH1')
        assert.deepEqual(check, { exists: true, name: 'remote.bin', size: 42 })
        assert.equal(mock.state.checkFileRequests[0]['hash'], 'HASH1')
      },
    )
  })

  it('maps exist:false and detects size mismatches', async () => {
    await withHarness({ checkFileResponse: { exist: false } }, async ({ client }) => {
      const check = await client.verifyUploadedFile('HASH2')
      assert.deepEqual(check, { exists: false })
    })
    await withHarness(
      { checkFileResponse: { exist: true, name: 'x', size: 7 } },
      async ({ client }) => {
        await assert.rejects(
          () => client.verifyUploadedFile('HASH3', { expectedSize: 9 }),
          (err: VikingError) => err.kind === 'verification_failed',
        )
      },
    )
  })
})
