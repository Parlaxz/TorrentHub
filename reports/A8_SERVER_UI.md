# A8 — Server Mode Renderer UI (Viking Relay)

Status: **complete** (renderer lane). All work confined to `src/renderer/server/**`, `tests/renderer/server/**`, and this report.

## What was built

A compact "appliance control panel" Server Mode UI: first-run setup wizard (5 steps), dashboard with health/pairing/active-transfer/storage/history, settings, offline + interrupted states, and exit-confirmation flow. React 18 + TypeScript + Tailwind utility classes, dark/light compatible, accessible.

### Screens / components

| Area | Files | Notes |
| --- | --- | --- |
| App root & gate | `App.tsx`, `index.tsx`, `styles.css` | Chooses setup vs dashboard; clear error when preload bridge missing; `?demo=1` runs against the mock bridge |
| Setup wizard | `screens/setup/SetupWizard.tsx`, `steps/Step{Folder,Radmin,Qbit,Viking,Ready}.tsx` | Stepper; Next gated on per-step completion (pure machine) |
| Step 1 — Working folder | `StepFolder.tsx` | Drive detected, total/free storage, exact copy "Temporary torrent downloads and ZIP files are stored here."; manual path or suggestion `D:\VikingRelay`; renderer never touches fs |
| Step 2 — Radmin VPN | `StepRadmin.tsx` | ✓ Adapter found / ✓ IPv4; server address `26.x.x.x:47821`; not-found copy + [Retry]; ambiguous → choose from backend-returned safe interfaces only; never suggests 0.0.0.0 or other interfaces |
| Step 3 — qBittorrent | `StepQbit.tsx`, `domain/qbitErrors.ts` | Web API URL + API key (password field); [Test]; specific errors: not running / wrong key / version too old / invalid URL; success rows "qBittorrent connected" + "Supported version"; key cleared from DOM after save |
| Step 4 — Viking | `StepViking.tsx` | Adapts to backend: anonymous offered only if `supportsAnonymous`; hash-only if `requiresUserHash`; [Test] rendered **only** when backend exposes non-destructive validation (`bridge.testViking`) |
| Step 5 — Ready | `StepReady.tsx` | Radmin/qBittorrent/Viking/Storage checklist + [Start Server] (disabled until all pass) |
| Dashboard | `screens/Dashboard.tsx` | VIKING RELAY + SERVER badge, ● Online + address, status rows (Radmin/qBit/Viking/Storage), [Pair Client] [Settings], Exit w/ confirmation |
| Pairing | `screens/PairingModal.tsx` | Formatted code `K7RM-4Q2X` style, mm:ss expiry (urgent <60s), auto-generate on open + regenerate button, "Enter this code on the Client PC." No bearer tokens anywhere in the surface |
| Active transfer | `screens/ActiveTransferCard.tsx` | Name, phase label, progress bar %, speed, Seeds • Peers, ETA, stage chips Download→Packaging→Upload as they activate, storage free line |
| Storage | `screens/StorageCard.tsx` | Always-visible free space; during a job adds Remaining torrent / ZIP reservation / Projected headroom; low/critical space rendered as `role="alert"` banner |
| Offline | `screens/banners.tsx` | Radmin ● Disconnected + fixed copy "Server is unavailable to Client until Radmin reconnects." No alternate interface advertised |
| Interrupted | `screens/banners.tsx` | Exact copy incl. "Automatic resume is not supported."; actions strictly limited to real backend capabilities (dismiss / clean job data / open qBittorrent). No recovery wizard, no fake buttons |
| History | `screens/HistoryList.tsx` | Job name, final status dot+label, Viking URL when complete, timestamp |
| Settings | `screens/SettingsPanel.tsx` | Working folder, relay port, qBittorrent WebUI URL, write-only API key + Viking hash (mask + "Saved ✓", never echoed), Start-with-Windows (capability-gated), prevent-sleep-during-transfers (default on), mode note. No multipart/tuning knobs |
| Exit flow | `ExitConfirmDialog` in `banners.tsx` | Deliberate confirmation while a transfer is active; tip that closing the window hides to tray (main owns actual behavior) |
| Primitives | `components/ui.tsx` | StatusDot, Button, Card, ProgressBar, TextField, Toggle (role=switch), focus-trapped Modal, Banner, StatusRow |

### State & logic (framework-free, fully unit-tested)

- `state/setupMachine.ts` — pure wizard reducer + completion rules (`isStepComplete`, `setupChecklist`, `needsSetup`).
- `state/RuntimeContext.tsx` — single subscription point for `onHealth/onJob/onPairing` + initial load of settings/history/capabilities.
- `state/useNow.ts` — ticking clock for countdowns.
- `domain/format.ts` — bytes/speed/countdown/ETA/timestamp formatting (spec-style: `1.4 TB`, `221 GB`, `38.7 MB/s`, `09:42`).
- `domain/derive.ts` — storage rows, low-space messages, transfer summary/stage chips, readiness rows, radmin-offline rule, pairing countdown (TTL-clamped against stale ticks).
- `domain/secrets.ts` — `SECRET_MASK`, display states, runtime leak guard `assertNoPlaintextSecrets`.
- `domain/qbitErrors.ts` — specific probe-error copy.

## Preload / backend assumptions

All backend access goes through ONE seam: `VikingRelayServerBridge` (`bridge/types.ts`), resolved via `window.vikingRelayServer` in `bridge/serverBridge.ts` (the only module touching `window`). When the real preload lands, adapt it there — screens never change.

Assumed contract highlights:

- **Secrets are write-only**: `setQbitApiKey(key)` / `setVikingUserHash(hash)` return `{ok}`; settings expose only `qbitApiKeySet` / `vikingUserHashSet` booleans (+ masked hint for Viking). Plaintext can come back only via optional `revealQbitApiKey()` behind `capabilities.revealSecrets` (default false). Nothing touches localStorage.
- **Storage**: `setWorkingFolderPath(path)` / `chooseWorkingFolder()` return drive stats + writability validated by main.
- **Radmin**: `getRadminStatus()` may return `problem:"ambiguous"` + safe `candidates[]`; renderer pins via `selectRadminInterface(id)`. The renderer never requests binding to 0.0.0.0.
- **Capabilities gate UI**: `testViking`, `startWithWindows`, `powerSaveBlocker`, `dismissInterruptedJob`, `cleanJobData`, `openQBittorrentWebUi`, `closeToTray`, `revealSecrets`. Features without capability flags simply don't render.
- **Events**: main pushes ~1/s `onHealth` / `onJob` during activity plus `onPairing`.
- **Job shapes** mirror A5 (`src/main/jobs/types.ts`): `progressPct/speedBps/seeds/peers`, `StorageView{freeBytes, remainingDownloadBytes, zipReservationBytes, projectedHeadroomBytes, warning}` — re-declared internally to keep lanes decoupled.
- **Lifecycle**: window-close-to-tray, powerSaveBlocker, and app exit are main-process owned; renderer only provides wording, toggles, and `requestAppExit()`.

`bridge/mockServerBridge.ts` implements the full contract in-memory (scenario-configurable) for tests and `?demo=1` preview.

## Tests / results

Runner: Vitest 2 + @testing-library/react + jsdom (component) and node environment (pure logic).

```
Test Files  6 passed (6)
Tests       62 passed (62)
tsc --noEmit (strict): clean
```

Verified in an isolated sandbox project (temp dir, not committed) because the repo root has no package.json yet; the test files are standard Vitest specs ready to run once root scaffolding exists.

Coverage:
- `format.test.ts` — byte/speed/countdown/ETA/clamp edge cases.
- `derive.test.ts` — storage row filtering, low-space copy, transfer phases (download→packaging→upload→terminal), stage chip transitions, readiness rows, radmin-offline message, pairing expiry/urgency + stale-tick clamp.
- `setupMachine.test.ts` — every step's completion rule (writable folder w/ drive, connected Radmin w/ IPv4, supported probe, anonymous vs user-hash vs unconfigured), navigation clamps, key-clear-on-save, URL change invalidating probe, `needsSetup`.
- `secrets.test.ts` — mask rendering, plaintext-leak guard throws, AppSettings carries no plaintext secret fields.
- `setupWizard.test.tsx` — folder step render + Next gating, Radmin disconnected/retry, connected address `26.14.203.87:47821`, ambiguous candidate selection, qBittorrent specific errors ×4 + success rows + key cleared and absent from DOM, invalid URL.
- `dashboard.test.tsx` — online header/status rows/storage free, offline banner on event, pairing code format + 10:00 countdown + regenerate + no "bearer" text + urgent <60s styling, active transfer mirror (74%, 38.7 MB/s, Seeds 7 · Peers 18, 221 GB free), packaging chip advance, critical-space alert, interrupted exact copy + capability-gated actions + dismiss refresh, settings save-key flow (input cleared, Saved ✓, plaintext nowhere in DOM, settings object leak-guarded), exit confirmation while active.

## Integration gaps

1. **Root scaffold pending**: needs `package.json` (react, react-dom, vitest, jsdom, @testing-library/*, tailwindcss), Vite/electron build wiring, `tailwind.config` with `darkMode:'class'`, and `styles.css` included in the renderer HTML entry (`#root`).
2. **Preload implementation** must expose `window.vikingRelayServer` matching `bridge/types.ts`; until then the app shows a friendly "could not reach its local service" screen, and `?demo=1` renders with the mock.
3. **Theme switching**: components use Tailwind `dark:` variants; main should toggle the `dark` class on `<html>` (mirror OS or tray setting).
4. **History links**: rendered as anchors with `preventDefault`; external opening should be routed through main (`shell.openExternal`) — add a bridge method when available.
5. **Job type alignment**: internal job types intentionally duplicate A5 shapes; swap to shared contracts when the shared lane lands (single import site per file).
6. **Interrupted detection** uses live job state or newest history entry; if A5 later exposes a dedicated flag, wire it in `Dashboard`.

## Files changed

```
src/renderer/server/
  App.tsx                          index.tsx                         styles.css
  bridge/types.ts                  bridge/serverBridge.ts            bridge/mockServerBridge.ts
  components/ui.tsx
  domain/format.ts                 domain/derive.ts                  domain/secrets.ts        domain/qbitErrors.ts
  state/setupMachine.ts            state/RuntimeContext.tsx          state/useNow.ts
  screens/Dashboard.tsx            screens/ActiveTransferCard.tsx    screens/StorageCard.tsx
  screens/HistoryList.tsx          screens/PairingModal.tsx          screens/SettingsPanel.tsx
  screens/banners.tsx
  screens/setup/SetupWizard.tsx
  screens/setup/steps/StepFolder.tsx   screens/setup/steps/StepRadmin.tsx
  screens/setup/steps/StepQbit.tsx     screens/setup/steps/StepViking.tsx
  screens/setup/steps/StepReady.tsx

tests/renderer/server/
  format.test.ts   derive.test.ts   setupMachine.test.ts   secrets.test.ts
  setupWizard.test.tsx   dashboard.test.tsx

reports/A8_SERVER_UI.md
```

No files outside this lane were created or modified.
