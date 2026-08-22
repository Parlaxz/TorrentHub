# A2 — qBittorrent Integration & Torrent Intake (Viking Relay)

Status: **IMPLEMENTED** (not merely designed). 15 source modules, 9 test files, **43/43 tests passing**.

---

## 1. Official API behavior actually verified

Research performed 2026-08-22 against the official WebUI API wiki, qBittorrent master sources
(`torrentscontroller.cpp`, `serialize_torrent.cpp/.h`, `webapplication.cpp`, `apistatus.h`), the
API-key wiki, and qBittorrent release notes. Where docs conflicted, upstream source was treated as
authoritative.

### Authentication
| Fact | Detail | Source |
|---|---|---|
| API keys exist in qBittorrent **5.2.0+** | `Authorization: Bearer qbt_<28 chars>`; stateless; one active key; generated via WebUI Preferences (NOT `setPreferences`) | API-key wiki + 5.2.0 release notes |
| Cookie auth still works in 5.2+ | `POST /api/v2/auth/login` (form `username`/`password`) → `Ok.` + `SID` cookie | wiki + controller source |
| CSRF constraint | Cookie requests need `Referer`/`Origin` matching Host exactly. We always send `Referer: <baseUrl origin>`. | webapplication.cpp |
| ⚠ Doc conflict | API-key wiki claims "WebAPI v2.14.1" availability; release notes say 5.2.0 = WebAPI **2.11.9**. We gate on the **qBittorrent version** (≥ 5.2.0) for key support. | noted in report |

### Version / compatibility endpoints
- `GET /api/v2/app/version` → plain text, e.g. `v5.2.0`
- `GET /api/v2/app/webapiVersion` → plain text, e.g. `2.11.9`
- No `webapiVersionMajor/minor` endpoints exist (prompt suspicion confirmed unfounded).

### Metadata-only inspection — the big finding
qBittorrent **5.2.0 / WebAPI 2.11.9** added a dedicated endpoint:

```
POST /api/v2/torrents/fetchMetadata        form: source=<magnet|http(s) URL|infohash>
```

Verified from `fetchMetadataAction()` source:
- **HTTP 200** → full metadata JSON: `{hash, infohash_v1, infohash_v2, info: {files: [{path, length}], length, name, piece_length, pieces_num, private}, trackers?, webseeds?, created_by?, creation_date?, comment?}`. The torrent-id key is literally `"hash"` (`KEY_TORRENT_ID`, serialize_torrent.h).
- **HTTP 202** → still fetching (`APIStatus::Async` → 202, verified in `webapplication.cpp`). Body is an infohash-only object for magnets, `{}` for URL sources.
- **HTTP 400/422** → unparseable source / "not a valid torrent file".
- Nothing is added to the session; metadata cache is keyed by torrent id and reused by a later `/torrents/add`.
- `POST /api/v2/torrents/parseMetadata` exists for uploaded .torrent files (not needed V1).

Pre-5.2 fallback (opt-in via `minWebApiVersion: '2.11.0'`): add with `stopped=true` +
`stopCondition=MetadataReceived` → qBittorrent fetches metadata and stops itself before any payload
piece is requested (officially supported pattern). Parked under tag/category `vr_intake`.

### Adding torrents
`POST /api/v2/torrents/add` (multipart). Verified current parameter set includes: `urls`,
`savepath`, `category`, `tags`, `stopped`, `stopCondition` (**TitleCase**: `None` |
`MetadataReceived` | `FilesChecked`), `contentLayout`, `autoTMM`, `rename`, `filePriorities`, …
Response body `Ok.` / `Fails.`. `paused`→`stopped` rename happened in **WebAPI 2.11.0**.
Add-time `filePriorities` exists (2.11.9) but only applies when metadata is already cached
server-side and must match file count exactly — we deliberately do NOT rely on it (see §3).

### File list & priorities
- `GET /api/v2/torrents/files?hash=` → `[{index, name, size, progress, priority, availability, piece_range, is_seed}]`; empty array when metadata absent; `is_seed` only on first element (legacy quirk).
- `POST /api/v2/torrents/filePrio` → `hash`, `id` = pipe-separated indexes, single `priority`.
  Values: **0 = do not download**, 1 = normal, 6 = high, 7 = maximal. **Works while the torrent is stopped** — this is what makes the race-free flow possible.

### Torrent info / states
- `GET /api/v2/torrents/info?hashes=a|b&includeFiles=true`. Field names verified against
  `serialize_torrent.h`: `hash, name, state, progress, size, total_size, downloaded,
  downloaded_session, completed, amount_left, dlspeed, upspeed, eta, num_seeds, num_complete,
  num_leechs, num_incomplete, category, tags, save_path, content_path, completion_on, added_on,
  availability, magnet_uri, auto_tmm`.
- State enum (current): `error, missingFiles, uploading, stoppedUP, queuedUP, stalledUP, checkingUP,
  forcedUP, downloading, metaDL, forcedMetaDL, stoppedDL, queuedDL, stalledDL, checkingDL, forcedDL,
  checkingResumeData, moving, unknown`. Old `pausedDL/pausedUP` are gone since WebAPI 2.11.0.
- ETA sentinel: `8640000` (= ∞) mapped to `null`; swarm counts `-1` (unknown) mapped to `null`.

### Stop/start, tags/categories, delete
- `POST /torrents/stop` | `/torrents/start` (`hashes=pipe|list`) since WebAPI 2.11.0; pause/resume remain as aliases.
- `createTags(tags=a,b)`, `addTags(hashes,tags)`, `removeTags`, `createCategory(category, savePath,…)` (idempotency handled client-side), `setCategory(hashes, category)`.
- `POST /torrents/delete` (`hashes`, `deleteFiles`).
- Duplicates: adding an existing infohash is NOT reliably idempotent ("Ok." ≠ created). We detect pre-add via `info?hashes=<hash>` and re-check after any `"Fails."`.

---

## 2. Differences from the assumptions in the task prompt

1. **Intake token**: the API provides NO token. We mint `vr_intake_<canonicalHash>` locally and resolve it through an in-process registry.
2. **stopCondition casing**: prompt suggested lowercase (`metadataReceived`); actual accepted values are TitleCase (`MetadataReceived`).
3. **Metadata-only fetch**: better than assumed — a dedicated `fetchMetadata` endpoint exists on 5.2+, so inspection adds NOTHING to the session at all on default settings.
4. **"Add with unselected files priority 0 from the beginning"**: per-file priorities cannot be safely supplied at add time for async URL/magnet sources (server requires cached metadata; count must match exactly). Equivalent guarantee implemented instead: **add STOPPED → deselect (priority 0) FIRST → select (priority 1) → read back & verify → only then start**. Since the torrent never runs before verification, no payload can begin — same product guarantee, fewer server-version pitfalls.
5. **Priority semantics**: confirmed 0 = do not download; also verified priorities apply while stopped.
6. **Stop/start naming**: confirmed `stop`/`start` (WebAPI ≥ 2.11.0); we refuse servers below that.

---

## 3. Race-free commit flow (hard requirement)

```
inspectTorrent(source)
  └─ 5.2+: POST fetchMetadata (poll 202→200)      ← nothing added to session
  └─ <5.2: add(stopped=true, stopCondition=MetadataReceived, quarantine vr_intake)

commitTorrentSelection(token, selectedIndexes, jobId, savePath)
  ├─ duplicate check: GET info?hashes=<hash>
  │    ├─ unowned identical torrent  → DuplicateUnmanagedTorrentError (never commandeered)
  │    └─ other job's vr_job_* tag   → DuplicateUnmanagedTorrentError
  ├─ absent → add(stopped=true, stopCondition=MetadataReceived[magnet], savepath, category, tags, autoTMM=false)
  ├─ ownership markers: createCategory(vr_job_<jobId>, savePath) + createTags + addTags + setCategory (+ remove intake tag)
  ├─ filePrio(unselected → 0)   ← FIRST, failure-safe ordering
  ├─ filePrio(selected   → 1)
  ├─ READ BACK files; verify every priority applied → else SelectionNotAppliedError, NO start
  ├─ start(hash)
  └─ post-start sanity: error-state → stop + TORRENT_ERRORED; identity/tag/savepath drift → stop + OwnershipMismatchError
```

Selected-file completion (`getJobProgress` / `getSelectedFilesCompletion`) uses the **stored
selected-index list as canonical truth** and per-file `progress` from `/torrents/files` — never
whole-torrent progress (which includes deselected files and may never reach 1.0) and never disk
contents.

Low-seed behavior: zero speed / zero connected seeds are ordinary values; `stalledDL` classifies as
`waiting_for_peers`; ETA ∞ sentinel → `null`. Nothing in the adapter times out a slow torrent.

Destructive ops (`cleanupJobTorrent`) require caller proof: `expectedInfoHash` (mandatory),
optional explicit `expectedTag` / `expectedSavePathPrefix` (default to recorded job values).
Deletion always targets one concrete hash; `"all"` is rejected outright.

---

## 4. Source files (all inside owned lanes)

```
src/main/qbit/
  index.ts       public surface (52 ln)
  service.ts     QbitTorrentService — job-engine entry point (93)
  client.ts      typed WebAPI client + version gate (332)
  http.ts        fetch transport: Bearer/cookie auth, timeouts, multipart (215)
  inspect.ts     metadata-only inspection, both tiers (236)
  commit.ts      race-free selective commit (295)
  progress.ts    progress mapping + selected completion (129)
  lifecycle.ts   guarded stop/cleanup/discardIntake (117)
  ownership.ts   vr_job_ markers + verifyOwnership guard (117)
  registry.ts    intake/job registries (33)
  statemap.ts    raw state → semantic classification, ETA normalization (46)
  magnet.ts      magnet/URL validation + btih/btmh extraction (113)
  tokens.ts      vr_intake_<hash> minting/parsing (19)
  errors.ts      14 typed error classes (133)
  types.ts       all contracts incl. wire types (258)

tests/qbit/      auth/version/inspect/commit/progress/lifecycle tests + harness/mock/fixtures
reports/A2_QBITTORRENT.md
```

No files outside `src/main/qbit/**`, `tests/qbit/**`, `reports/A2_QBITTORRENT.md` were touched.
Zero runtime dependencies (hand-rolled fetch wrapper); zero Node builtins in the adapter core
(Electron-render-safe by construction).

## 5. Tests and results

**43/43 passed** (zero-dependency harness; mocked WebUI responses; injectable `fetchImpl`).

Coverage of required cases:
- API-key auth (Bearer header present on every call; 403 → `QbitAuthError`) ✔
- cookie login fallback (proactive login, SID cookie, Referer, failed login → typed error) ✔
- version gate (below-min rejected; exact-min passes; API key vs pre-5.2 rejected; missing endpoint → unsupported) ✔
- metadata inspection (202-polling → 200 ready; timeout → `METADATA_UNAVAILABLE`; bad source local + server-side rejection; malformed metadata) ✔
- fallback tier parking (add stopped + MetadataReceived + vr_intake quarantine asserted on the wire) ✔
- file-index selection mapping (unselected `prio:0:0,2` FIRST, selected `prio:1:1`, start strictly after verify) ✔
- fresh-add path asserts `stopped=true`, `stopCondition=MetadataReceived`, category/tags/savepath/autoTMM on the multipart body ✔
- duplicate unmanaged refused (no re-add, no mutation, no start); foreign-job-owned refused ✔
- priority verification failure prevents start ✔
- progress mapping (speeds, ETA sentinel, swarm −1→null, classification table incl. legacy `pausedDL`→unknown) ✔
- zero seeds/speed non-fatal → `waiting_for_peers` ✔
- selected-completion ignores deselected files; canonical selection-list truth; missing-metadata degradation ✔
- destructive ownership guard (hash mismatch / missing tag / savepath escape / empty proof / `"all"` target all refuse without deleting) ✔
- guarded stop; discardIntake deletes parked torrent with `deleteFiles=false` ✔

How to run (no package.json changes made — repo toolchain is owned by another writer):
```
tsc --module commonjs --target es2022 --moduleResolution node --esModuleInterop --skipLibCheck ^
    --strict --lib es2022 --lib dom --outDir <tmp> ^
    src/main/qbit/index.ts tests/qbit/*.test.ts tests/qbit/harness.ts tests/qbit/mock.ts tests/qbit/fixtures.ts
node <tmp>/run.mjs     # imports suites, runs sequentially, exits non-zero on failure
```
(Verified with global tsc 4.9.5 + Node 25.2.1.) Once package.json lands, porting to vitest/node:test
is mechanical: each test file maps 1:1; replace `harness.ts` imports with the runner's equivalents.

## 6. Integration surface exported to the job engine

```ts
import { QbitTorrentService } from 'src/main/qbit';

const qbit = new QbitTorrentService({
  baseUrl: 'http://localhost:8080',
  apiKey: '<qbt_...>',            // or username/password for cookie mode
  timeoutMs?: number,
  minWebApiVersion?: string,      // default '2.11.9'
});

await qbit.healthCheck(): Promise<QbitCapabilities>          // {qbtVersion, webApiVersion, tier}
const t = await qbit.inspectTorrent(magnetOrUrl, opts?): Promise<InspectedTorrent>
//   { token: 'vr_intake_<hash>', name, infoHash, infoHashV1|V2, files[{index,path,size}], totalSize }
const c = await qbit.commitTorrentSelection({ token, selectedIndexes, jobId, savePath })
//   → { jobId, infoHash, infoHashV1|V2, name, savePath, category:'vr_job_<jobId>', tag, selectedIndexes }
await qbit.getJobProgress(jobId): Promise<JobProgress>
//   progress, selectedProgress, downloadedBytes, wantedBytes, downloadedWantedBytes,
//   downloadSpeedBps, uploadSpeedBps, etaSeconds|null, seedsConnected/Swarm, peersConnected/Swarm,
//   stateRaw, classification ('downloading'|'waiting_for_peers'|'metadata'|'queued'|'stopped'|
//   'completed'|'checking'|'moving'|'error'|'unknown'), completion{complete,...}
await qbit.getSelectedFilesCompletion(jobId)   // canonical "all REQUESTED files done" signal
await qbit.stopJobTorrent(jobId)               // ownership-guarded stop before packaging
await qbit.cleanupJobTorrent(jobId, { expectedInfoHash, expectedTag?, expectedSavePathPrefix? },
                             { deleteFiles? }) // proof-guarded deletion
await qbit.discardIntake(token)                // drop abandoned intake (deletes parked fallback torrent)
```

Typed errors (all carry `.code`): `QbitUnreachableError`, `QbitUnsupportedVersionError`,
`QbitAuthError`, `QbitApiError`, `InvalidTorrentSourceError`, `MetadataUnavailableError`,
`MalformedMetadataError`, `DuplicateUnmanagedTorrentError`, `QbitTorrentErroredError`,
`OwnershipMismatchError`, `IntakeNotFoundError`, `SelectionInvalidError`,
`SelectionNotAppliedError`, `ValidationError`.

## 7. Unresolved concerns / follow-ups

1. **No live-server integration test yet.** All behavior is verified against upstream source + mocks. Recommend one smoke pass against real qBittorrent 5.2.x (auth, fetchMetadata poll, filePrio read-back) before shipping.
2. **In-memory intake registry.** A restart between `inspectTorrent` and `commitTorrentSelection` loses the token (commit then raises `INTAKE_NOT_FOUND`). Committed jobs stay verifiable via qbt tags alone. If cross-restart intakes are needed, persist `{token → source}` to storage later.
3. **Theoretical check-then-add race** on duplicates (WebAPI has no atomic add-or-get). Mitigated: post-add existence re-check converts `"Fails."` into `DuplicateUnmanagedTorrentError`.
4. **Server-side filename filtering** (`applyFilenameFilter`) can silently alter priorities; our mandatory read-back verification catches this and refuses to start (`SELECTION_NOT_APPLIED`).
5. **`removeTags` endpoint** was not explicitly re-verified in the changelog research (long-standing endpoint; failure is caught and ignored during commit).
6. **v2/hybrid torrents**: canonical lookup uses qbt's internal torrent id (`hash` field); v1/v2 hashes are surfaced separately for identity proofs. Magnet-only-btmh sources resolve their id from API responses rather than local parsing.
7. **Category savePath vs autoTMM**: we force `autoTMM=false` everywhere so the caller-supplied save path governs; if a future feature wants TMM, revisit.
