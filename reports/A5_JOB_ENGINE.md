# A5 — Job Engine and Transfer Pipeline

Status: **implemented, 16/16 tests passing, strict typecheck clean**.
Lane ownership respected: only `src/main/jobs/**`, `tests/jobs/**`, `reports/A5_JOB_ENGINE.md` were touched.

## What it is

The simple authoritative state machine coordinating:
`torrent metadata -> file selection -> disk preflight -> qBittorrent download -> optional ZIP -> Viking upload -> final result -> cleanup`.

V1 concurrency: **one active transfer pipeline at a time** (second `commitSelection` while one is active throws). Intake drafts are allowed concurrently. There is no multi-job scheduler.

Crash/restart recovery is intentionally NOT implemented: on startup, nonterminal jobs from previous sessions are marked `interrupted`; qBittorrent is never inspected to reconstruct state; ZIP and Viking multipart state are never resumed.

## State machine

Job states (`src/main/jobs/types.ts`):

```
reading_metadata ──► awaiting_selection ──► queued ──► downloading ──► packaging ──► uploading ──► finalizing ──► complete
       │                    │                 │             │               │              │
       └── failed           └── cancelled    └─cancelled   ├─ failed       ├─ failed      ├─ failed
                                                          └─ cancelled   └─ cancelled   └─ cancelled
```

- `failed` carries `error: { kind, message, insufficientSpace? }` with kind ∈ `metadata | storage_preflight | download | storage_before_packaging | packaging | upload | finalize`.
- `interrupted` is set ONLY by `JobEngine.startupSweep()` for previous-session nonterminal jobs; `lastKnownStage` records the last non-waiting stage.
- Preflight rejection does NOT fail the job: it stays `awaiting_selection` with error kind `storage_preflight`, so Start can be retried.

Stage states: each of `metadata, selection, preflight, download, packaging, upload, finalize, cleanup` is `waiting | active | complete | failed | skipped`.
Notable details:

- Single-file path: `packaging = skipped`, source = exact selected file (`directSourcePath`).
- Cleanup failure after successful upload: overall state stays `complete`, `result.cleanupWarning` set, `cleanup = failed`. Never downgraded to generic FAILED.
- Final URL/hash is persisted (`save:finalizing:url`) BEFORE any destructive cleanup step.

## Dependency interfaces (all inside `src/main/jobs/gateways.ts`)

The engine depends only on these narrow interfaces (constructor injection); concrete adapters live in other agents' lanes.

| Interface | Methods | Contract notes |
|---|---|---|
| `TorrentGateway` | `fetchMetadata(source)`, `addTorrent(source, {selectedIndexes, outputDir, tag})`, `getProgress(handle)`, `stop(handle)`, `deleteOwned(handle, deleteData)` | Metadata-only fetch before commit. Exact priorities from `selectedIndexes` (unselected ⇒ priority 0). `getProgress` polled ~1/s; zero seeds/speed is data, not an error. Once `selectedComplete=true` it MUST include `selectedFiles: [{index, absolutePath}]` — the adapter owns path layout (single-file torrents land directly in `outputDir`). `deleteOwned` must be GUARDED: only torrents carrying the ownership tag (default `"viking-relay"`, `VIKING_RELAY_TAG`). |
| `VikingGateway` | `upload(request)`, optional `verify?(result)` | Cancellation is cooperative via `request.abort` AbortSignal only. No undocumented abort API assumed. `verify` is an optional capability used at finalize; its failure never fails the job. |
| `PackagingGateway` | `createZip({inputPaths, outputZipPath, abort})` | Must honor `abort` and package exactly the explicit file list given. |
| `StorageGateway` | `statFreeBytes(path)`, `preflight({path, requiredBytes, safetyReserveBytes})` | Preflight verdict is authoritative for rejecting Start. `statFreeBytes` may return `null` (= unknown): engine proceeds without blocking but surfaces null headroom. Blocking semantics when exhaustion is imminent belong to the adapter; the engine additionally stops the torrent itself on critical headroom. |
| `JobRepository` | `loadAll()`, `upsert(record)`, `get(id)`, `findByIdempotencyKey(key)` | Key lookup matches intake key OR start key. |
| `WorkspaceGateway` | `createJobDirs(jobId)`, `removePath(path)`, `join(...)`, `pathExists(path)` | Default impl `FsWorkspaceGateway(root)` creates `<root>/jobs/<jobId>/{download,package}`. |

## Files

```
src/main/jobs/
  types.ts          states, stages, JobRecord, telemetry/storage views
  gateways.ts       narrow dependency interfaces + VIKING_RELAY_TAG
  errors.ts         InsufficientSpaceError, InvalidTransitionError, JobNotFoundError, JobEngineError
  ids.ts            job id / session epoch / idempotency-key normalization
  config.ts         JobEngineConfig + DEFAULT_CONFIG (thresholds below)
  json-repository.ts JsonJobRepository: single history JSON, cap 100 (oldest evicted by updatedAt),
                    atomic tmp+rename writes, serialized write chain; torn/missing file => empty history
  speed-hints.ts    SpeedHintTracker: sustained 0 B/s => 'waiting_for_peers', sustained < slowSpeedBps => 'slow'
  storage.ts        computeStorageView headroom math + FsWorkspaceGateway
  pipeline.ts       TransferPipeline: per-job state machine, polling, retries, stage-aware cancel
  engine.ts         JobEngine facade: intake, commit+idempotency, cancel, retry*, startupSweep,
                    discardArtifacts, listJobs/getJob, whenIdle
  index.ts          public barrel export

tests/jobs/
  fakes.ts          fake gateways + MemoryJobRepository (no real I/O)
  harness.ts        makeHarness() with event-ordering log + waitFor()
  success-path.test.ts, failures.test.ts, engine-lifecycle.test.ts
```

Per-job workspace: `<jobsRoot>/jobs/<jobId>/download/` and `/package/`. The "small state file" is the central versioned history JSON (`{version:1, jobs:[...]}`) — equivalent to per-job `job.json`, chosen to keep writes atomic in one place.

## Storage model (deliberately coarse)

During download, every poll tick computes:

```
remainingDownload = selectedBytes - downloadedBytes
zipReservation    = zipRequired ? selectedBytes : 0     // ZIP ≈ input size while both exist
projectedHeadroom = free - remainingDownload - zipReservation - safetyReserveBytes
warning: projectedHeadroom < 0                => 'critical' (exhaustion imminent)
         projectedHeadroom < lowHeadroomBytes => 'low'
```

- `critical` during download → torrent stopped safely, job fails with `kind:'download', insufficientSpace:true`; downloaded data preserved.
- Fresh check before ZIP: if `free < selectedBytes + safetyReserveBytes` → ZIP is NOT begun; job fails `storage_before_packaging` with completed download preserved.
- Commit-time preflight peak: `selectedBytes + (zipRequired ? selectedBytes : 0)`.
- Zero seeds / zero speed NEVER fails or cancels anything; hints are presentation-only with configurable thresholds (`zeroSpeedMs=60s`, `slowSpeedBps=256 KiB/s`, `slowSpeedMs=120s`).

## Exact retry semantics

| Path | Precondition | Effect |
|---|---|---|
| Start retry after preflight rejection | state `awaiting_selection`, error `storage_preflight` | Call `commitSelection` again; re-runs preflight, then proceeds. |
| `retryPackaging(id)` | `failed` + kind `packaging` | Verifies all completed input files still exist (`InvalidTransitionError` otherwise). Re-zips only. Never redownloads/re-adds torrent. Continues upload→finalize→cleanup. |
| `retryUpload(id)` | `failed` + kind `upload` | Re-uploads existing `zipPath`/`directSourcePath` as-is. No redownload, no repackage. |
| `retryStorageCheck(id)` | `failed` + kind `storage_before_packaging` | Fresh `statFreeBytes`; passes → packaging onward; still short → `failed` again with refreshed storage view. |

Retries run through the same single-transfer chain; calling while another transfer is active rejects with `InvalidTransitionError`. On any retry the owned torrent handle is reconstructed from persisted `torrentId`, so final cleanup still deletes the owned torrent.

## Exact cancellation semantics (`cancel(id, {cleanup=false})`)

| State | Behavior |
|---|---|
| `reading_metadata` / `awaiting_selection` / `queued` (no live pipeline) | → `cancelled` immediately; nothing was added to qBittorrent. |
| `downloading` | Flags set; poll loop unwinds within ~1 poll interval; `stop()` then guarded `deleteOwned(handle, deleteData=true)` exactly once. Owned torrent+data always deleted (a cancelled download has no value). |
| `packaging` | ZIP AbortSignal fires; partial ZIP deleted. Torrent preserved unless `cleanup:true` (then owned torrent+data also deleted). |
| `uploading` | Upload AbortSignal aborts active PUTs cooperatively. Local source preserved unless `cleanup:true` (then ZIP + owned torrent+data removed). |
| `finalizing` with result already persisted | Refused (`InvalidTransitionError`) — the URL is durable, job will complete. |
| terminal states | No-op. |

`discardArtifacts(id)` (terminal jobs only) is the manual cleanup button: guarded `deleteOwned(torrentId, true)` + `removePath(jobDir)`; adapter refusals are swallowed best-effort.

## Idempotency

Two independent, optional keys per job:

- Intake key (`createIntake(source, key)`): concurrent or repeated calls with the same key return the same draft (in-flight map + repository lookup).
- Start key (`commitSelection(id, indexes, key)`): bound to the record on success. Replay after lost HTTP response returns the same started job unchanged. If the key is already bound to a DIFFERENT job, that job is returned instead of creating a duplicate.

Repository `findByIdempotencyKey` matches either field.

## Crash/restart policy (intentionally simple)

`startupSweep()` marks every nonterminal job whose `sessionEpoch ≠ current epoch` as `interrupted`, notes `lastKnownStage`, and performs NO qBit inspection, no ZIP resume, no Viking multipart resume. Users clean up later via `discardArtifacts` or manually.

## Tests & results

Run (Node ≥ 22.6, zero dependencies):

```
node --test "tests/jobs/*.test.ts"
```

Typecheck:

```
npx -p typescript@5.9.2 tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions --types node src/main/jobs/index.ts tests/jobs/*.test.ts
```

Result: **16 pass / 0 fail**, typecheck clean.

| Required scenario | Test |
|---|---|
| successful one-file direct path | ✔ `successful one-file direct path (packaging skipped)` |
| successful multifile ZIP path | ✔ `successful multifile ZIP path` |
| start blocked for insufficient disk | ✔ `start blocked when preflight reports insufficient disk` (+ retry-Start succeeds) |
| storage becomes insufficient before packaging | ✔ `... specific failure + retry-storage-check` |
| zero seeds does not fail | ✔ `zero seeds / zero speed does not fail the job` |
| packaging failure retains download, retry works | ✔ `packaging failure retains download and retryPackaging completes` |
| upload failure retains source, retry skips repackaging | ✔ `upload failure retains source and retryUpload skips repackaging` |
| final URL persisted before cleanup call | ✔ event-ordering assertion `final URL persisted before destructive cleanup call` |
| cleanup failure retains successful result | ✔ `cleanup failure keeps successful result with warning` |
| duplicate idempotency key | ✔ `duplicate idempotency key returns the same job` (concurrent intake, commit replay, cross-job redirect) |
| cancel | ✔ 4 tests: draft, during download, during packaging (partial ZIP deleted, torrent preserved), full-cancel during upload |
| stale previous-session job → interrupted, not resumed | ✔ asserts zero gateway calls during sweep |

Extra: `V1 concurrency: second transfer rejected while one is active`.

## Assumptions for integration

1. **Language/runtime**: TypeScript ESM, Node ≥ 22.6. Relative imports use explicit `.ts` specifiers so tests run directly via Node's native type stripping. For bundling/tsc emit use `allowImportingTsExtensions`+`noEmit`, `rewriteRelativeImportExtensions`, or a bundler — build config belongs to the root/package owner.
2. **No runtime dependencies**: only `node:crypto`, `node:fs/promises`, `node:path`.
3. **Wiring**: construct `new JobEngine({torrent, viking, packaging, storage, workspace, repository}, resolveConfig({jobsRoot, historyFilePath}))`, then `await engine.startupSweep()` once at boot before serving requests.
4. **Required config**: `jobsRoot`, `historyFilePath`. Defaults exist for all thresholds (poll 1000 ms, safety reserve 1 GiB, low-headroom 512 MiB, history cap 100).
5. **Adapter obligations**: see interface table — especially `selectedFiles` absolute paths on completion and the guarded `deleteOwned` tag check.
6. **REST mapping suggestion**: `POST /intakes` → `createIntake`; `POST /jobs/{id}/selection` → `commitSelection`; `DELETE /jobs/{id}` → `cancel`; `POST /jobs/{id}/retry/{packaging|upload|storage-check}`; `GET /jobs`, `GET /jobs/{id}`; map the `Idempotency-Key` header to both key parameters. `engine.whenIdle()` exists for graceful shutdown/tests.
7. **Polling tolerance**: up to 10 consecutive `getProgress` errors are tolerated (~10 s) before the download fails; fewer than that just skips a tick.
8. **Unknown free space** (`statFreeBytes → null`) never blocks by itself; headroom fields surface as `null` ("do not make up false precision").
