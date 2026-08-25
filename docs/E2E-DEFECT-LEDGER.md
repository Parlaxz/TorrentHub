# E2E Defect Ledger

Every defect found during the campaign. Classification: A product / B test / C environmental /
D platform / E contract ambiguity. (Populated during Phase 5 triage.)

## Confirmed defects

| ID | Test ID | Severity | Class | Root cause | Fix | Regression test | Status |
|---|---|---|---|---|---|---|---|
| DEF-001 | SANITY-001/002 | low | B | Specs launched Electron with `out/main/index.js` as app dir → `app.getVersion()` returned Electron's version; tray icon path also broken in that mode | Launch with repo root as app dir (`args: ['.']`) | sanity.spec.ts (green) | fixed |
| DEF-002 | CLUSTER-SMOKE | low | B | Harness bridge-expression helper didn't prefix `window.`; intake input has no `type="text"` attr | Fixed helper auto-prefix; specs use aria-label locators | cluster-smoke.spec.ts (green) | fixed |
| DEF-003 | UI-004 | medium | **A** | `GlobalSettingsModal` is an inline overlay with only backdrop `onClick={onClose}` — no keydown handler, unlike server `Modal` (ui.tsx) which closes on Escape | Added Escape keydown effect when open | shell-settings.spec.ts UI-004 (green) | fixed |
| DEF-004 | SET-* (any modal action) | medium | **A** | Server `Modal` panel had no `max-h`/`overflow-y-auto`: tall SettingsPanel content pushed bottom actions outside the viewport, unreachable by pointer | Shared Modal panel now `max-h-[85vh] overflow-y-auto` | shell-settings.spec.ts SET-* (green) | fixed |
| DEF-005 | SETUP-040..050 | high | **A** | Viking step unusable both ways: (a) `setVikingUserHash('')` returned mode `'unconfigured'`, never `'anonymous'` → radio could never check, step could not complete anonymously; (b) user-hash radio onChange only focused a field that renders only when mode==='user_hash' → catch-22, field unreachable. Wizard could not be finished AT ALL via real UI | (a) controller returns `{mode:'anonymous'}` after clearing hash; (b) new `VIKING_MODE_PICK` reducer action flips mode locally on radio select | setup-wizard.spec.ts 20/20 green incl. SETUP-050 finish→Dashboard | fixed |
| DEF-006 | PERM-001 | medium | **A** | `connectionStatus()` probed PUBLIC `/v1/health` (no auth) → revoked token still reported "connected"; the `unauthorized→offline` mapping was dead code | New authenticated `serverStatus()` probe (`GET /v1/server/status`) with bearer token; status now truthfully flips offline on revocation | auth-pairing.spec.ts PERM-001 (green) | fixed |
| DEF-007 | PERM-002 | high | **A** | `GET /v1/history` (and job reads/mutations) were not tenant-scoped: any paired client received every terminal job and could cancel/mutate another client's job by id. Dashboard (local UI) correctly sees all | JobRecord gains `clientId` attributed at intake creation; visibility enforcement in EngineJobService for ALL reads AND mutations (`assertMutableBy` → 404 `job_not_found`, no existence leak); routes thread authenticated clientId; dashboard unscoped by design; legacy records (no clientId) visible to dashboard only. Mutation gap found+closed in follow-up pass | auth-pairing.spec.ts PERM-002 (real pass: bob sees no alice jobs, foreign mutations 404 ×4, owner cancel works); FAIL-030 updated to owner-path cancel | fixed |
| DEF-008 | SETUP-050 | high | **A** | After finishing the wizard, `onComplete` was a no-op and RuntimeContext loaded settings once at mount → Gate kept rendering the wizard forever even after Start Server succeeded; user stuck until app restart | RuntimeContext gained `refreshSettings()`; Gate re-reads settings on wizard completion | setup-wizard.spec.ts SETUP-050 (green) | fixed |
| DEF-009 | CORE-023/031 | medium | **A** | Client-mode `copyText` used sandboxed-preload `clipboard.writeText`, which fails (returns false) in current Electron → all client Copy buttons silently broken. Server bridge already routed through main correctly | New `client:copyText` IPC handler using main-process clipboard; preload invokes it | core-journey.spec.ts CORE-023/031 (green) | fixed |
| DEF-010 | CORE-020 | high | **A** | Server Dashboard "Recent transfers" never updated: pushTick emits `findActiveJob()` which is null for terminal jobs, and short pipelines finish between 1 s ticks → renderer never learns of completion. Evidence: bridge getHistory showed complete while dashboard said "No finished jobs yet."; 17 pushes all null | Observable repository: composition wraps upsert with change listeners; controller emits snapshot per persisted change incl. terminal; plus terminal-transition push in pushTick | diag probe shows full lifecycle pushes + dashboard shows entry; CORE-020 green | fixed |
| DEF-011 | FAIL-001 | high | **A** | `getIntake()` returned null for any non-`{reading_metadata, awaiting_selection}` state → failed drafts invisible to the client, which spun on "reading metadata" forever (server history showed `failed` at t=1s; client stuck 15s+). Client type `IntakeDraftView.state` already includes `'failed'` — server contradicted the declared contract | `INTAKE_STATES` now includes `'failed'`; client onData guards null drafts | failures.spec.ts FAIL-001 (green, 5.9s) | fixed |
| DEF-012 | INT-013 | medium | **A** | Empty `selection: []` passed the relay schema (missing `.min(1)` documented in shared/api.ts), reached the engine, threw an untranslated error → HTTP 500 `internal_error` instead of 400 | `jobCreateSchema.selection` now `.min(1).max(10_000).nullish()` | relay-api.spec.ts INT-013 (green) | fixed |
| DEF-013 | FAIL-042 | low | **A** | Commit-time duplicate refusal wrapped as kind:`download`; errors.ts mapped `download` → `"unknown"` unconditionally, making the `duplicate_torrent` taxonomy unreachable (generic "Something went wrong" shown) | `case "download"` now falls through to message heuristics → truthful "Duplicate torrent" title | failures.spec.ts FAIL-042 asserts "Duplicate torrent" + full message (green) | fixed |
| DEF-014 | A11Y-001 | medium | **A** | Server `Modal` (and GlobalSettingsModal) never moved initial focus into the dialog on open — keyboard users start Tabbing from behind the overlay; trap only engages after focus enters manually. Evidence: activeElement was the trigger button (`inDialog:false`) | Both modals now focus first focusable element (panel fallback via tabIndex=-1) on open | a11y.spec.ts A11Y-001 (green) | fixed |

## Wire-contract findings (documented, no defect)

| Finding | Source | Disposition |
|---|---|---|
| `POST /v1/intakes` returns `IntakeDraftView {id,…}`, not the documented `{intakeId}` envelope | relay-api INT-010 | shared/api.ts doc drift; harmless — update docs when contracts refresh |
| `POST /v1/jobs` commit auto-starts the pipeline; snapshot may already be `downloading` (never `awaiting_selection` on the wire) | relay-api INT-012; also shaped FAIL-020 rewrite | intended atomicity; plan/doc wording updated |
| Declined direct-jobs remain visible in inbox with state `declined` | MULTI-022 | intentional UX; plan wording updated |
| Cleanup flags on SelectionScreen are EXPLICIT per-job overrides sent with Start — they supersede server defaults (settings.cleanupDelete*) | FAIL-042 diagnosis | document as product contract |

## Suspected / under investigation

None. All lanes reconciled; every finding was either fixed (with regression coverage) or
documented as an intentional disposition.
