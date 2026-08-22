# A7 — Client Mode Renderer UI

Status: **complete**. Full Client Mode lane implemented, typechecked (`tsc -p tsconfig.json`: 0 errors in `src/renderer/client/**`), linted (0 problems), and unit-tested (54/54 passing across the repo's suite; 5 of 6 test files are this lane's).

## Files / screens / components

```
src/renderer/client/
├── index.tsx                  # default-exports <ClientApp/> — mounted by src/renderer/src/App.tsx shell
├── App.tsx                    # phase state machine: boot → connect → home → intake → selection → active → complete/error/history
├── types.ts                   # INTERNAL domain types (seam mirroring A5 src/main/jobs/types.ts)
├── styles.css                 # client-only base CSS + indeterminate-bar keyframes (Tailwind v4 comes from shell global.css)
├── lib/
│   ├── bridge.ts              # VikingBridge seam: expected preload/main surface + getBridge() injection point
│   ├── format.ts              # bytes / speed / ETA / percent / count formatting
│   ├── treeModel.ts           # pure file-tree model: build, tri-state annotate, flatten, toggle, stats
│   ├── preflight.ts           # zipNotice / startBlocked / storageVerdict (server-authoritative only)
│   ├── errors.ts              # classifyJobFailure/classifyMessage → specific error presentations
│   ├── stages.ts              # deriveDisplayStages + speedAdvisory (pure)
│   └── usePolling.ts          # fixed-cadence polling hook with reconnect semantics + cleanup
├── components/
│   ├── ui.tsx                 # Button/TextInput/Field/Panel/Badge/Spinner/StatusDot/ErrorText/EmptyState
│   ├── ProgressBar.tsx        # ProgressBar + ProgressBlock (bar, %, done/total, ↓speed, ETA)
│   ├── StagePipeline.tsx      # DOWNLOAD / PACKAGE / UPLOAD TO VIKING vertical stages (✓/✕/–/spinner states)
│   ├── StorageTable.tsx       # label→bytes table + yellow/red StorageWarning banner
│   └── FileTree.tsx           # hierarchical checkbox tree, search filter, built-in windowed rendering
└── screens/
    ├── ConnectScreen.tsx      # 1  pair & connect / change server (IP, port, XXXX-XXXX code)
    ├── HomeScreen.tsx         # 2  connection status + torrent/magnet input with validation
    ├── MetadataScreen.tsx     # 3  "Reading torrent…" indeterminate progress + cancel
    ├── SelectionScreen.tsx    # 4  tree selection → Continue → preflight → ZIP warning → Start gating
    ├── ActiveJobScreen.tsx    # 5  stage pipeline, seeds/peers, storage panel, warnings, retries
    ├── CompleteScreen.tsx     # 8  ✓ Complete, Viking URL, Copy Link (bridge clipboard, select-text fallback)
    ├── ErrorScreen.tsx        # 9  all specified error states incl. Retry Packaging / Retry Upload
    └── HistoryScreen.tsx      # 10 minimal recent jobs list with Copy
```

Tests:
- `src/renderer/client/__tests__/` — treeModel, preflight+start-gating, format, errors, stages (run by current vitest config `src/**/*.test.ts`, node env).
- `tests/renderer/client/` — SelectionScreen.test.tsx, ActiveJobScreen.test.tsx, usePolling.test.tsx (DOM tests; see "Tooling gaps").

## Behaviour highlights

- **Selection is canonical qBittorrent FILE INDEXES**: `confirmSelection(jobId, [...selected].sort((a,b)=>a-b))`; verified by test.
- **ZIP warning**: exactly 1 selected → "Upload selected file directly", no warning. 2+ → prominent ⚠ ZIP REQUIRED block naming `<TorrentName>.zip`, no-recompression note, temporary size from server preflight (local selection bytes as provisional figure until the server answers).
- **Storage**: renderer never computes disk math. Preflight table renders Selected files / Temporary ZIP / Safety reserve / Peak required / Server free verbatim; verdict line "✓ Enough storage" or "⚠ NOT ENOUGH SERVER STORAGE — need approximately X GB more". Start disabled when `blocked || !enough`. Changing the selection invalidates a stale preflight and requires re-Continue.
- **Active job**: three independent stages, no fake overall percentage. Complete = ✓, active = spinner + bar, skipped packaging = dashed badge + "Single file is uploaded directly", failed = ✕ + message + Retry Packaging / Retry Upload buttons.
- **Low seeds / zero speed are warnings, never FAILED**: hint-driven ("Waiting for peers" blue advisory with "Viking Relay will keep waiting."; "Few available seeds" amber), conservative telemetry fallback (seeds===0 → waiting; seeds≤2 → few-seeds). Speed shown prominently; ETA when meaningful.
- **Storage during download**: server `storage.warning` 'low' → yellow banner; 'critical' → strong red banner.
- **Polling**: draft ~700 ms during metadata read; job ~1000 ms while active; connection status every 3 s + push subscription. A failed poll flips to "Reconnecting…" (badge + banner stating the download continues on the server) and the next success renders authoritative state; timers are cleared on unmount/disable and in-flight results are ignored (all covered by fake-timer tests).
- **Secrets**: pairing values pass straight through the bridge to main (safeStorage); nothing touches localStorage. Clipboard uses the bridge only, falling back to select-the-URL text.
- **Scale**: FileTree flattens the annotated tree into fixed-height rows rendered through a small built-in windower (absolute positioning + overscan) — 20k-file torrents stay light without extra dependencies. Search filters visibility only; folder checks always apply to all descendants including hidden matches (unit-tested).
- **A11y**: real checkboxes with native indeterminate, `role="tree/treeitem"` with aria-level/expanded/selected, labelled progressbars, role="alert"/"status" banners, focus-visible outlines, keyboard-operable controls.

## API assumptions (VikingBridge seam in lib/bridge.ts)

| Bridge method | Expected backing (shared/api.ts routes) |
|---|---|
| getConnection/pair/forgetConnection/connectionStatus/onConnectionChanged | POST `/api/pair` (pin → token stored via safeStorage in main); status derived by main |
| createIntake(input) | POST `/api/intake` {source} → {intakeId} |
| getDraft(jobId) | GET `/api/intake/:id/metadata` (+ state/error wrapper) |
| confirmSelection(jobId, indexes) | POST `/api/jobs` CreateJobRequest{intakeId, selectedIndex} → Job + storage figures |
| startJob/getJob/cancelJob | GET `/api/jobs/active`, GET/POST `/api/jobs/:id(/cancel)` |
| retryPackaging/retryUpload | POST `/api/jobs/:id/retry` |
| listHistory | GET `/api/history` → {jobs} mapped to HistoryEntry |
| copyText | safe preload clipboard |

Error mapping: structured fields first (`insufficientSpace`, FailureKind, ApiErrorCode `storage_blocked`), then conservative message heuristics for qBittorrent-unavailable / unsupported-version / duplicate / bad-torrent / metadata-timeout. Replace heuristics when structured codes land.

## Missing contracts expected from integration

1. **Client job bridge**: preload currently exposes only getState/setMode/updateSettings/secrets (`src/shared/ipc.ts`). The VikingBridge methods above must arrive as a preload extension or a main-side adapter over the REST routes; install it via `setBridgeForTests`-style injection or rewrite `getBridge()` (single place). Deliberately did NOT redeclare `window.vikingRelay` to avoid conflicting with shared's global type.
2. **StoragePreflight shape**: assumed `{selectedFiles, selectedBytes, tempZipBytes|null, safetyReserveBytes, peakRequiredBytes, serverFreeBytes, enough, missingBytes?, blocked?}` returned on selection confirm. A5's JobRecord has no such field yet.
3. **PackagingProgress / UploadProgress**: assumed optional `packagingProgress`/`uploadProgress` on the polled JobSnapshot (processed/total/%, MB/s, free; uploaded/total/%, MB/s, ETA, partCount). Absent today — UI degrades to Waiting states.
4. **Critical-storage action text**: spec asks for a backend-supplied red action; StorageView has only `warning: none|low|critical`. Renderer shows generic strong copy until a field exists.
5. **Connection events**: `onConnectionChanged` push channel assumed; polling fallback already works without it.

## Tooling gaps (root-config owner)

- `vitest.config.ts` includes only `src/**/*.test.ts` with node env; jsdom + @testing-library/react are not devDependencies. Therefore the three DOM tests in `tests/renderer/client/` are written but not runnable until config adds them (e.g. include `tests/**/*.test.{t,j}sx`, environment jsdom per-file via docblocks already present, devDeps `@testing-library/react`, `jsdom`). Pure-logic coverage was colocated under `src/renderer/client/__tests__/` so it runs today.

## Flow description (final)

Launch → shell mode chooser → ClientApp. Unpaired: VIKING RELAY pairing form (Server IP / Port / Pairing Code) → Pair & Connect. Paired launches land on Home showing ● Connected/Reconnecting/Offline + host, with Change Server and History in the header. Paste magnet/URL → Continue → "Reading torrent…" (indeterminate, cancelable) → file tree with search, Select All/None, live count/bytes → Continue runs the server preflight → ZIP warning (2+) or direct-upload note (1) + storage table + verdict → Start (disabled if blocked) → Active job screen with DOWNLOAD/PACKAGE/UPLOAD TO VIKING stages, seeds/peers, speed/ETA, server-storage panel, low-seeds and storage warnings, reconnect handling → ✓ Complete with Viking URL, Copy Link, New Torrent. Failures land on specific error cards (retry affordances where applicable); interrupted jobs show the fixed "Automatic resume is not supported" guidance. Recent jobs remain one click away.
