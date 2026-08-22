# A1 — Foundation, Electron Shell, and Shared Contracts

Status: **lane complete**. Typecheck/tests/lint are green for all A1-owned files.
Remaining repo-wide errors belong to other concurrent lanes (listed at the end).

## Files created / changed (A1-owned)

Root config:
- `package.json` (created twice — see "Incidents")
- `package-lock.json` (regenerated against the dependency set below)
- `tsconfig.json` (web/renderer program), `tsconfig.node.json` (main/preload/configs)
- `electron.vite.config.ts`, `vitest.config.ts`, `eslint.config.mjs`
- `electron-builder.yml`
- `.gitignore`, `.env.development`, `.env.production`

Electron app:
- `src/main/index.ts` — bootstrap, single-instance lock, window creation, security handlers
- `src/main/logger.ts` — Pino (file + dev stdout)
- `src/main/app-paths.ts` — userData path abstraction (`logs/`, `data/`, settings/secrets files)
- `src/main/store.ts` — generic JSON store (atomic tmp+rename), settings load/save
- `src/main/settings-store.ts` — validated in-memory settings holder
- `src/main/secrets.ts` — safeStorage-backed secret store (DPAPI on Windows)
- `src/main/ipc.ts` — zod-validated IPC handlers
- `src/preload/index.ts` — narrow contextBridge

Shared contracts (single source of truth for all lanes):
- `src/shared/domain.ts` — AppMode, JobState (+`isTerminalJobState`), StageState, FilePriority,
  TorrentFile, TorrentMetadata, Download/Packaging/UploadProgress, StorageStatus,
  StructuredError, StageSnapshot, JobResult, JobStages, Job
- `src/shared/api.ts` — REST route table, ApiError envelope + codes, request/response schemas
  (health, pairing, intake, metadata, create-job, active job, job by id, cancel, retry, history)
- `src/shared/ipc.ts` — IPC channel names, payload validation, `VikingRelayBridge` interface +
  `Window.vikingRelay` global declaration
- `src/shared/settings.ts` — `AppSettings` schema, patch schema, defaults
- `src/shared/index.ts` — barrel
- `src/shared/__tests__/contracts.test.ts` — 11 focused contract tests

Renderer shell:
- `src/renderer/index.html` (CSP via `%VITE_CSP%` env substitution)
- `src/renderer/src/{main.tsx,App.tsx,ModeChooser.tsx,global.css}`
- `src/renderer/client/index.tsx`, `src/renderer/server/index.tsx` — **placeholders only**
  (marked as such; client agent has since added `client/App.tsx` + `types.ts`,
  server agent added full UI tree — neither collides with these mount points)

## Package versions selected (verified current via `npm view` on 2026-08-22)

Runtime deps: react/react-dom ^19.2.8, fastify ^5.12.1, @fastify/cors ^11.3.0,
zod ^4.4.3, archiver ^8.0.0 (+@types/archiver), pino ^10.3.1.

Tooling: electron ^43.4.1, electron-vite ^5.0.0, electron-builder ^26.15.3,
vite ^7.3.6, @vitejs/plugin-react ^5.2.0, tailwindcss + @tailwindcss/vite ^4.3.3,
typescript ~5.9.3, vitest ^4.1.11, eslint ^10.9.0 + typescript-eslint ^8.67.0,
@types/node ^24.

Deliberate downgrades from "latest" (peer-range verified):
- **vite 7, not 8** — electron-vite 5 peer range is vite ^5||^6||^7.
- **@vitejs/plugin-react 5.x, not 6.x** — v6 requires vite ^8.
- **typescript ~5.9, not 7.x** — typescript-eslint supports <6.1.0.
- No `type: module` in package.json → main/preload bundles stay CommonJS, required for
  `sandbox: true` preloads.

## Commands

`npm run dev | build | preview | dist | typecheck | lint | test | test:watch`
- `dist` = build + electron-builder NSIS x64 installer into `dist/`.
- typecheck runs both TS programs (node + web).

## Architectural decisions

1. **Zod schemas are the contracts.** Types are `z.infer`-derived so REST payloads, IPC args,
   and persisted settings share one validation source. Timestamps are epoch-ms numbers
   (avoids ISO-parsing API drift across zod majors).
2. **Renderer talks to the Server PC over plain fetch** (CSP `connect-src http: https:`).
   Radmin targets are arbitrary private IPv4s, so no host allowlist is possible; this is a
   deliberate, documented relaxation.
3. **CSP is injected per build mode** through Vite HTML env substitution (`%VITE_CSP%`):
   strict in production (no inline/eval scripts), relaxed in dev for HMR/React-refresh.
   A meta tag alone can't be conditional per mode; headers don't apply to `file://`.
4. **Settings shape** (`mode`, `serverPort` default 47613, `qbittorrentBaseUrl`,
   `dataDir`) is intentionally minimal. Domain agents should extend `src/shared/settings.ts`
   rather than creating parallel config stores.
5. **Secrets** are namespaced strings (`^[a-zA-Z0-9._-]+$`), encrypted via safeStorage into
   `userData/secrets.json`. Suggested key for pairing: `pairing.token`.
6. **`allowImportingTsExtensions: true`** was enabled in both tsconfigs because multiple
   concurrent lanes import with explicit `.ts` extensions (valid under noEmit + bundler
   resolution; esbuild/rollup handle it).
7. Crash recovery is out of scope; nothing here assumes restart-safe state.

## Electron security defaults

`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`;
preload exposes exactly `window.vikingRelay` ({ getState, setMode, updateSettings, secrets })
— no fs/child_process/raw IPC. `will-navigate` blocked outside the dev-server origin;
`setWindowOpenHandler` denies everything (http(s) forwarded to external browser);
all permission requests denied; single-instance lock enforced.

## App shell

First launch shows a mode chooser; choice persists to `settings.json`; header allows switching
modes (useful while both UIs mature). `App.tsx` mounts `src/renderer/client` /
`src/renderer/server` default exports; placeholders exist until those lanes land theirs.

## Incidents / notes for the integration agent

- **package.json was deleted mid-session** by an out-of-lane actor (an ad-hoc `npm install`
  created a stray `TorrentHub` lockfile + partial node_modules). It was recreated verbatim and
  the lockfile regenerated under `viking-relay`. If you see `name: "TorrentHub"` anywhere,
  it's stale residue.
- **Renderer build is currently blocked by `src/renderer/server/styles.css`** (server-UI lane):
  it uses Tailwind v3 directives (`@tailwind base/components/utilities`). Under Tailwind v4 it
  must be `@import 'tailwindcss';` (plus `@reference` if used for `@apply` in isolation).
  Main + preload bundles build clean; `npm run build` will pass once that one file is migrated.
- Server-UI comments assume class-based dark mode synced by main. Tailwind v4 defaults to
  `prefers-color-scheme`; if class strategy is wanted, their CSS needs
  `@custom-variant dark (&:where(.dark, .dark *));` and main can sync `nativeTheme`. Not
  implemented from A1 (out of lane).
- Client lane created `client/App.tsx`; my placeholder `client/index.tsx` still owns the mount
  point — rewire the barrel when integrating.

## Verification results (at time of writing)

- `npm test`: **11/11 passed** (shared contracts).
- `npm run typecheck`: **0 errors in A1-owned files**. 13 remaining errors are in
  `src/main/{jobs,package,qbit,relay,viking}` (other lanes' WIP: unused vars, duplicate
  identifier, archiver default-import typing, base32 Buffer encoding, etc.). Not touched
  per concurrent-writer rules.
- `npm run lint`: 0 problems in A1-owned files; 6 unused-var errors in other lanes' files.
- `npm run build`: main ✓ preload ✓; renderer blocked only by the styles.css issue above.
