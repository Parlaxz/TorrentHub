# B1 — Full Integration, Build, and End-to-End Reconciliation

Status: **COMPLETE**. One coherent codebase, one canonical contract set, real Client and
Server bridges, real qBit/Viking/packaging/storage wiring, real Fastify relay, zero known
TypeScript errors, zero build errors, all test suites reconciled, production Electron build
working, Windows NSIS installer built.

---

## 1. Executive result

Viking Relay is now a single buildable Electron application supporting both modes:

- **Server PC**: setup wizard (working folder → Radmin adapter → qBittorrent → Viking →
  Start) → dashboard with pairing, live transfer/storage/health, history, tray lifecycle.
  The relay serves the canonical `/v1` REST API on the selected Radmin IPv4:47821 only.
- **Client PC**: pair (code → safeStorage bearer token in main), paste magnet/URL,
  metadata-only intake, file-tree selection with authoritative storage preflight
  (ZIP warning for 2+ files), Start gated on server verdicts, live download/packaging/
  upload progress, final Viking URL + Copy Link.

Verification: `npm run typecheck` **0 errors** · `npm run lint` **0 problems** ·
`npm run test:all` **362 pass / 0 fail / 1 skip** across six runners · `npm run build` clean ·
`npm run dist` produced **`dist/Viking Relay-Setup-0.1.0.exe`** (~106 MB NSIS x64).

Only live validation outstanding: one manual two-PC smoke test against real qBittorrent
5.2+ / Viking / Radmin (§23). Everything mockable/local is complete.

## 2. Initial repository state

- A1 root scaffold (`viking-relay`): electron-vite 5 / Vite 7 / React 19 / Tailwind v4 /
  TS ~5.9 strict / Electron 43 / electron-builder 26 / Fastify 5 / Zod 4 / Archiver 8 /
  Pino 10. No stale TorrentHub lockfile residue. Directory is not a git repository.
- Typecheck baseline: 8 unused-symbol errors (node program) + 14 unused-React-import
  errors + 1 missing default export (web program).
- Renderer build blocked by Tailwind-v3 directives in `src/renderer/server/styles.css`.
- `vitest.config.ts` ran only `src/**/*.test.ts`: none of the A2–A6 `tests/**` suites or
  A7/A8 DOM suites executed.
- All eight lane reports read before any modification; lane implementations preserved.

## 3. Integration mismatches discovered

| # | Mismatch | Lanes |
|---|----------|-------|
| M1 | Default port 47613 vs canonical 47821 | A1/A6 |
| M2 | Tailwind v3 directives; duplicate CSS pipeline risk | A8/A1 |
| M3 | Class-based `dark:` (A8) vs media-query dark (A7/TW4 default) | A7/A8/A1 |
| M4 | Server entry missing default export for shell mount | A8/A1 |
| M5 | Unused React imports (JSX transform mismatch) | A8/A1 |
| M6 | `shared/api.ts` described never-implemented `/api/*`; A6 `/v1/*` is the real wire | A1/A6 |
| M7 | Shared idealized Job DTO vs engine `JobRecord` actually served by `/v1` | A1/A5/A6 |
| M8 | A5 `createZip({inputPaths})` loses torrent-relative paths/sizes required by A4 | A5/A4 |
| M9 | A5 coarse disk math vs A4 canonical policy | A5/A4 |
| M10 | No progress callbacks on gateways → packaging/upload invisible to UI | A5/A3/A4 |
| M11 | A5 generic tag abstraction vs A2 job-specific ownership + proof-guarded cleanup | A5/A2 |
| M12 | Completed-file absolute paths must be derived safely per job, not folder-walked | A5/A2 |
| M13 | A6 TokenStore persistence unimplemented (paired clients die on restart) | A6/A1 |
| M14 | A7 expects rich client bridge; preload exposed only shell methods | A7/A1 |
| M15 | A8 expects `window.vikingRelayServer`; not exposed | A8/main |
| M16 | A6 JobService port had no concrete implementation | A6/A5 |
| M17 | Client networking would live in renderer (token exposure risk) | A7/security |

## 4. Resolutions

- **M1** `DEFAULT_SETTINGS.serverPort = 47821`; client default port 47821; A6 already 47821.
- **M2/M3** Single Tailwind pipeline in `global.css` (`@import 'tailwindcss'`) +
  `@custom-variant dark (&:where(.dark, .dark *))`; main process mirrors
  `nativeTheme.shouldUseDarkColors` onto `<html class="dark">` (system preference drives
  it; overridable per-window). Server styles.css reduced to plain base CSS.
- **M4/M5** Default export added to `server/index.tsx`; unused React imports removed;
  `?demo=1` mock bridge gated behind `import.meta.env.DEV` (dead-code eliminated in prod).
- **M6/M7** `shared/api.ts` rewritten to the canonical `/v1` route table + wire schemas
  (pair/intakes/jobs/history/server-status, error envelope `{error, message?, issues?}`);
  `shared/domain.ts` now holds engine-aligned public DTOs (`JobSnapshot`, `StorageView`,
  `PreflightView`, telemetry/progress views, `IntakeDraftView`). Contracts test rewritten
  to pin these shapes.
- **M8** `ZipRequest` now carries explicit `entries[]`
  (`absoluteSourcePath, archiveRelativePath, sizeBytes, torrentFileIndex`). Pipeline builds
  entries from metadata paths + completed files; adapter maps 1:1 onto
  `packageSelectedFiles`. Basename flattening impossible; hierarchy preserved.
- **M9** `PreflightRequest` carries canonical facts (`selectedBytes/fileCount/zipRequired`);
  `StoragePolicyGateway` implements preflight/liveHeadroom/evaluatePackagingStart with A4's
  pure functions (`estimateZipBytes`, `computeSafetyReserve`, `computeLiveHeadroom`,
  `evaluatePackagingStart`, fresh statfs). Engine persists an authoritative `PreflightView`
  on both success and blocked paths; legacy coarse math remains only as fallback when
  canonical inputs are absent (tests/fakes).
- **M10** Zip/Upload requests accept `onProgress`; pipeline throttles persistence (~750 ms)
  into `JobRecord.packagingProgress/uploadProgress`; served via `/v1` snapshots.
- **M11/M12** `QbitTorrentGateway` keeps A2 semantics: handle carries full proof
  (`jobId, infoHash, savePathPrefix`); `deleteOwned` requires hash + `vr_job_<jobId>` +
  save-path containment (post-restart fallback replicates the guard locally via
  `verifyOwnership` before deleting); completed paths derived from live `content_path`
  layout and validated inside the per-job download root. Never weakens to a generic tag.
- **M13** `SafeStorageTokenPersistence` stores the HMAC secret + token digests encrypted
  (SecretStore keys `auth.tokenSecret`, `auth.tokens`); paired clients survive restarts;
  raw tokens never stored server-side. Covered by integration test.
- **M14** `src/main/client-relay/**` (HTTP client + service) owns connection config,
  pairing, bearer token (safeStorage key `client.bearerToken`), timeouts, structured
  errors, health, polling calls. Preload exposes `window.vikingClientBridge` — exactly
  A7's seam key, so zero screen changes were needed.
- **M15** Real `window.vikingRelayServer` implemented over `ServerController` (composition
  root) through validated IPC channels + event push (`server:event`).
- **M16** `EngineJobService` maps every relay route to the engine; public snapshots strip
  all server-local filesystem fields; typed errors map to 404 `job_not_found` /
  409 `job_conflict`; blocked Start returns 201 with `storagePreflight.blocked=true`.
- **M17** Renderer receives plain JSON via narrow IPC only. Never sees bearer token,
  qBit API key, Viking user/hash, or server filesystem paths.

## 5. Canonical architecture after integration

```
Electron main
├─ src/main/index.ts            bootstrap, single instance, security, theme sync,
│                               close→tray (server mode), tray menu, powerMonitor
├─ src/main/ipc.ts              shell bridge (A1): state/mode/settings/secrets
├─ src/main/client-relay/       CLIENT MODE backend (main-only networking)
│   ├─ http-client.ts           fetch + bearer + timeouts + RelayClientError taxonomy
│   ├─ service.ts               pair/status/intake/jobs/history; token via SecretStore
│   └─ ipc-channels.ts
├─ src/main/server/             SERVER MODE composition
│   ├─ composition.ts           settings/secrets/log → QbitTorrentService, VikingClient,
│   │                           gateways, JsonJobRepository, FsWorkspaceGateway,
│   │                           JobEngine(+startupSweep once), EngineJobService,
│   │                           AuthController(safeStorage persistence), RelayManager
│   ├─ controller.ts            ServerController = window.vikingRelayServer impl
│   ├─ auth-persistence.ts      TokenPersistence over safeStorage
│   └─ ipc-server.ts / ipc-channels.ts
├─ src/main/integration/        SEAM ADAPTERS
│   ├─ qbit-gateway.ts          A5 TorrentGateway ⇐ A2 QbitTorrentService
│   ├─ viking-gateway.ts        A5 VikingGateway ⇐ A3 VikingClient
│   ├─ packaging-gateway.ts     A5 PackagingGateway ⇐ A4 packageSelectedFiles
│   ├─ storage-gateway.ts       A5 StorageGateway ⇐ A4 storage policy (canonical)
│   └─ job-service.ts           A6 JobService port ⇐ A5 JobEngine (+public DTO mapping)
└─ lanes untouched: src/main/{qbit,viking,package,storage,jobs,relay,auth}

Renderer (sandboxed, no Node)
├─ src/preload/index.ts         exposes window.vikingRelay (shell),
│                               window.vikingClientBridge (client),
│                               window.vikingRelayServer (server); clipboard only
├─ src/renderer/src/            shell: mode chooser mounts client/server apps
├─ src/renderer/client/         A7 UI (unchanged screens; bridge is now REAL)
└─ src/renderer/server/         A8 UI (unchanged screens; bridge is now REAL)

Wire: Fastify /v1 REST (A6) — health, pair, intakes, jobs (+cancel/retry-packaging/
retry-upload/recheck-storage), history, server/status. Bearer auth, rate limits,
idempotency keys, no stack traces, no CORS.
```

## 6. Exact adapters/mappers created

See §5 tree. Notable mapping decisions:
- `torrentId` = canonical qBittorrent hash; handle carries proof fields so retry paths
  reconstruct guarded deletion after restart.
- `confirmSelection` → `POST /v1/jobs {intakeId, selection, idempotencyKey: start-<id>}`;
  blocked Start returns the record (still `awaiting_selection`) plus blocked preflight.
  `startJob` replays the same key with the job's PERSISTED selection (set before
  preflight even on the blocked path) — idempotent replay, no duplicate transfers.
- Packaging progress maps A4 `PackagingProgress` → engine view → renderer DTO.
- Upload progress maps A3 byte-accurate events (rollback-safe totals) → engine view.
- Verification uses A3 check-file; failure never destroys a returned URL (engine semantic).

## 7. Shared-contract changes

- `shared/settings.ts`: port 47821; added `radminInterfaceId`, `startWithWindows`,
  `preventSleepDuringTransfers`, `clientServerHost/clientServerPort` (all defaulted so old
  settings.json parses). Canonical store remains A1's; A8 view names are mapped at the
  controller seam (`workingFolderPath↔dataDir`, `relayPort↔serverPort`, `qbitWebUiUrl↔
  qbittorrentBaseUrl`).
- `shared/domain.ts`: engine-aligned public DTOs (see §4/M7). Old idealized schemas retired.
- `shared/api.ts`: canonical `/v1` routes + envelopes.
- `shared/ipc.ts`: unchanged shell surface.

## 8. Electron main composition

`ServerController.ensureGraph()` builds the engine graph lazily ONCE per process and runs
`await jobEngine.startupSweep()` exactly once before jobs are exposed (marks nonterminal
previous-session jobs INTERRUPTED; no qBit reconstruction, no ZIP resume, no multipart
resume). Qbit/Viking instances are swappable via providers (config changes applied only
while idle). `startServer()` rebuilds only the relay transport (port/adapter changes apply)
and starts the 1 s health/job push loop; `stopServer()` stops transport only — engine work
is independent. Power: `powerSaveBlocker('prevent-app-suspension')` while a transfer is
active and `preventSleepDuringTransfers` is set; released when idle. Login item via
`app.setLoginItemSettings({openAtLogin})`. Window close in server mode hides to tray;
tray offers Open / status / Exit; exit confirmation for active transfers lives in the A8
UI flow before `requestAppExit`.

## 9. Client preload/REST flow

Renderer → `window.vikingClientBridge` → IPC → `ClientRelayService` → `RelayHttpClient`
(bearer from safeStorage, 10 s timeout, structured `RelayClientError`) → Server `/v1`.
Pairing saves host/port as normal settings + token encrypted. Connection status derives
from `/v1/health`. Copy Link uses preload `clipboard.writeText` only.

## 10. Server preload flow

Renderer → `window.vikingRelayServer` → validated IPC channels → `ServerController` →
real services. Secrets write-only (`qbitApiKeySet/vikingUserHashSet` booleans + masked
hint; reveal capability deliberately false). `probeQbittorrent` uses A2 `healthCheck` to
distinguish not_running / auth / version_too_old / invalid_url. `testViking` capability is
false — the Viking API has no non-destructive credential validation, so no fake button.
External URLs (qBit WebUI, Viking links) go through http(s)-validated `shell.openExternal`.

## 11. Auth persistence

Server: HMAC secret + digests encrypted via safeStorage (DPAPI) — verified by integration
test "persists token digests + HMAC secret so paired clients survive restarts" (raw token
asserted absent from storage). Client: raw bearer token encrypted at
`client.bearerToken`. This is authentication persistence only — NOT transfer recovery.

## 12. Storage policy (A4 canonical)

- Preflight: `selectedBytes + estimatedZipBytes(=sel + n·512 + 64 KiB) +
  safetyReserve(max(2 GiB, 5%))` vs fresh statfs; status ok/warning/blocked; deficit exact.
- Live during download: `remainingDownload + zip + reserve` vs fresh free each poll tick;
  `blocked→critical` stops the owned torrent safely (data preserved).
- Fresh packaging gate: A4's in-packager `evaluatePackagingStart` (fresh statfs, throws
  `InsufficientDiskSpaceError(phase='packaging-start')` before creating artifacts);
  gateway-level `evaluatePackagingStart` powers Retry Storage Check semantics.
- Engine persists `record.preflight` (authoritative rows: Selected files / Temporary ZIP /
  Safety reserve / Peak required / Server free / missing bytes / blocked).

## 13. qBit ownership/deletion proof

Commit creates category+tag `vr_job_<jobId>`, add stopped → priority 0 first → select →
read-back verify → start. Deletion requires expectedInfoHash + expectedTag +
expectedSavePathPrefix against the LIVE torrent; `"all"` rejected; unmanaged duplicates
never commandeered. Post-restart deletion replicates the same three checks locally before
issuing delete. Zero-seed/slow is data, never an error (`waiting_for_peers` hint).

## 14. Packaging selected-file proof

Explicit entries only; packager never walks directories; symlinks rejected; lstat size ==
declared size; STORE ZIP64 streaming; `<name>.partial.zip` → atomic rename; fresh disk
check inside the packager; partial deleted on cancel/failure; sources untouched.

## 15. Viking integration

Anonymous supported (`user=''`); user hash main-process only, redacted from logs/errors.
Concurrency 3, bounded backoff, stall timeouts, byte-exact rollback-safe progress,
ETag capture verbatim, check-file verification before cleanup decision.

## 16. Radmin binding

A6 rules preserved: candidates filtered to safe non-internal IPv4 (never 0.0.0.0/loopback);
strong radmin|famatech name match; explicit pin stored as `radminInterfaceId` (the bind
address); ambiguous → UI choice among safe candidates; adapter loss → `unavailable`
(watcher rebinds on return; never falls back to Wi-Fi/Ethernet). Firewall guidance is
surfaced via snapshot `bindError`; documented manual rule (run only with explicit consent):
`netsh advfirewall firewall add rule name="Viking Relay" dir=in action=allow protocol=TCP localport=47821`

## 17. UI fixes

Tailwind v4 migration + class-based dark variant synced from nativeTheme; server entry
default export; demo mock dev-only; unused imports removed. Client screens unchanged —
they consume the now-real bridge (preflight tables, ZIP warning, stage pipeline, retries,
reconnecting handling, waiting-for-peers advisory all render from authoritative values).

## 18. All files changed (B1)

Root: `package.json` (+jsdom/@testing-library/react/jest-dom/dom, tsx; scripts
test:node/test:auth-relay/test:integration/test:qbit/test:viking/test:all),
`vitest.config.ts`, `electron-builder.yml` (+extraResources icon), `build/icon.png` (new),
`scripts/run-qbit-tests.mjs` (new).

Shared: `domain.ts` (rewritten public DTOs), `api.ts` (rewritten /v1), `settings.ts`
(port + new fields), `__tests__/contracts.test.ts` (rewritten).

Main: `index.ts` (lifecycle/tray/theme/security), `store.ts` (dirname removal),
`secrets.ts`/`ipc.ts`/`app-paths.ts` unchanged; `jobs/gateways.ts` (entries/canonical
inputs/progress/handle proof), `jobs/types.ts` (+PreflightView, progress views, dismissed),
`jobs/pipeline.ts` (entries, canonical storage, progress wiring, throttled saver),
`jobs/engine.ts` (canonical preflight inputs + persisted PreflightView + proof handles),
`qbit/service.ts` (+getJobTorrentInfo), `qbit/http.ts` (unused param),
`package/zipWriter.ts` (unused import), `viking/viking-client.ts` (unused import),
`relay/http/routes.ts` + `relay/jobService.ts` (unused symbols, conflict message).

New: `src/main/integration/{qbit,viking,packaging,storage}-gateway.ts`, `job-service.ts`;
`src/main/client-relay/{http-client,service,ipc-channels}.ts`;
`src/main/server/{composition,controller,auth-persistence,ipc-server,ipc-channels}.ts`.

Preload: `index.ts` (three bridges). Renderer: `src/global.css`, `server/styles.css`,
`server/index.tsx`, 12 server files (React import removal), `vite-env.d.ts` (new).

Tests: `tests/renderer/client/*.tsx` (path depth fix, usePolling chain-order fix),
`tests/renderer/server/*.tsx` (jsdom docblocks), `tests/jobs/success-path.test.ts`
(entries contract), `tests/qbit/*` + `tests/auth/ratelimit.test.ts` + `tests/relay/*` +
`tests/viking/viking-client.test.ts` (lint-only fixes), NEW
`tests/integration/{qbit-gateway,packaging-gateway,viking-gateway,job-service,pairing-auth,
disk-preflight,client-bridge,e2e-mock}.test.ts`.

## 19. Tests run + exact counts

| Runner | Suite | Result |
|---|---|---|
| vitest | shared contracts + A7 logic + A7/A8 DOM suites | **139 pass / 0 fail** (15 files) |
| node --test | A4 package/storage + A5 jobs | **93 pass / 0 fail / 1 skip** (symlink test needs privilege) |
| tsx --test | A6 auth + relay | **46 pass / 0 fail** |
| tsx --test | B1 integration seams | **19 pass / 0 fail** |
| tsc+harness | A2 qbit | **43 pass / 0 fail** |
| node runner | A3 viking | **22 pass / 0 fail** |
| **Total** | | **362 pass / 0 fail / 1 skip** |

New integration coverage maps to the required scenarios:
1. A2→A5 metadata→indexes→completed paths ✔ (`qbit-gateway.test.ts`)
2. A4→A5 multifile→correct ZIP entries ✔ (`packaging-gateway.test.ts`)
3. A3→A5 upload progress→final URL ✔ (`viking-gateway.test.ts`)
4. A5→A6 REST intake/start/get/retry/cancel mapping ✔ (`job-service.test.ts`)
5. Pairing code→token→authenticated call ✔ (`pairing-auth.test.ts`)
6. Disk preflight ZIP reservation + Start block ✔ (`disk-preflight.test.ts`)
7. Zero seeds waiting propagation without failing ✔ (`job-service.test.ts`)
8. Client bridge → main relay client → real Fastify relay ✔ (`client-bridge.test.ts`)
9. Server-side composition services (graph build, sweep, auth persistence) ✔
   (`pairing-auth.test.ts`; ServerController itself needs Electron runtime — see §22)
10. Final mock E2E: magnet→selection→simulated download→REAL small STORE ZIP→mocked
    Viking multipart→complete URL→guarded cleanup ✔ (`e2e-mock.test.ts`)

## 20. Typecheck / lint / build results

- `npm run typecheck`: **0 errors** (both programs).
- `npm run lint`: **0 problems**.
- `npm run build`: main ✓ preload ✓ renderer ✓ (single Tailwind pipeline, 48.6 kB CSS).

## 21. electron-builder / dist result

`npm run dist` → **`dist/Viking Relay-Setup-0.1.0.exe`** (NSIS x64, ~106 MB, signed with
local signtool, blockmap emitted, app icon embedded, tray icon shipped via
extraResources). Two transient environmental failures occurred mid-lane
(`WebAssembly.Memory(): could not allocate memory` while the machine was at ~3 GB free
RAM); both resolved by freeing RAM — toolchain and config are correct.

## 22. Remaining limitations

1. **Live external validation outstanding** (only gap): real qBittorrent 5.2+, real Viking
   upload, real two-PC Radmin pairing. All local/mock coverage is green.
2. `ServerController` (Electron-dependent) has no automated test; its pure collaborators
   (composition graph, auth persistence, adapters, relay) are covered. Manual verification
   happens in the first real run.
3. Intake registry is in-memory (A2 note): a restart between metadata fetch and commit
   loses the draft token; commit then re-inspects (metadata-only) automatically.
4. Tray icon is a generated placeholder; replace `build/icon.png` with branded art later.
5. Firewall rule is documentation-only by design (no silent netsh).
6. Demo mode (`?demo=1`) exists only in dev builds.

## 23. Exact manual steps for the first real two-PC test

SERVER PC:
1. Install qBittorrent ≥ 5.2, enable WebUI (localhost), generate an API key
   (Preferences → Web API), leave qBittorrent running.
2. Install Radmin VPN; connect both PCs to the same Radmin network.
3. Run `Viking Relay-Setup-0.1.0.exe`; choose Server Mode.
4. Setup wizard: pick working folder (enough free disk) → confirm detected Radmin IPv4
   (choose manually if ambiguous) → enter WebUI URL + API key, [Test] must show
   connected + supported version → configure Viking (anonymous, or paste account hash) →
   [Start Server].
5. First launch may need the firewall inbound rule above (Windows prompt or manual netsh).
6. Dashboard → [Pair Client]; keep the window in tray.

CLIENT PC:
7. Install the same exe; choose Client Mode; enter server Radmin IPv4 + 47821 + code.
8. Paste a magnet (small legal torrent recommended) → file tree → select files.
9. Multifile ⇒ ⚠ ZIP REQUIRED + exact disk table; Start disabled if blocked.
10. Watch download %/speed/seeds/peers/ETA/storage (0 seeds ⇒ "Waiting for peers", not an
    error) → packaging MB/s → upload MB/s/ETA → final Viking URL → Copy Link.
11. Optional real smoke of qBit alone: with the server configured, create any intake and
    confirm qBittorrent shows the torrent stopped-with-selection, then downloading only
    the selected files (non-destructive; cancel deletes the owned torrent).

Optional later real-Viking smoke: temporarily point `VikingClient.baseUrl` at
https://vikingfile.com via a debug build and upload a tiny file — NOT done during B1
(no arbitrary uploads without explicit configuration).
