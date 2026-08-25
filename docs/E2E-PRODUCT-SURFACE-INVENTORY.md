# E2E Product Surface Inventory — Viking Relay v0.4.3

Every reachable user-visible surface with a final disposition.
Dispositions: `E2E_REQUIRED`, `COVERED_BY_PARENT_FLOW`, `LOWER_LEVEL_ONLY_WITH_JUSTIFICATION`,
`PLATFORM_UNAUTOMATABLE_WITH_EVIDENCE`, `RETIRED/UNREACHABLE`, `OUT_OF_SCOPE_WITH_EXPLICIT_REASON`.

Test IDs reference `docs/E2E-EXHAUSTIVE-TEST-PLAN.md`.

## 1. Shell (all modes)

| # | Surface | Disposition | Tests |
|---|---|---|---|
| S1 | First-launch ModeChooser (Client PC / Server PC buttons) | E2E_REQUIRED | LIFE-001..003 |
| S2 | Mode persists across restart | E2E_REQUIRED | PERSIST-001 |
| S3 | Header mode badge (`client`/`server`/`unconfigured`) | E2E_REQUIRED | LIFE-004 |
| S4 | Header "Switch mode" button (both directions) | E2E_REQUIRED | NAV-001..002 |
| S5 | Header ⚙ Settings → GlobalSettingsModal open/close (button, backdrop, Escape?) | E2E_REQUIRED | UI-001..004 |
| S6 | GlobalSettings: Check for updates (+ status line, dev-disabled state) | E2E_REQUIRED | UI-005..007 |
| S7 | GlobalSettings: Start with Windows checkbox (persisted) | E2E_REQUIRED | UI-008 |
| S8 | GlobalSettings: Minimize to tray checkbox (persisted; behavior on close) | E2E_REQUIRED | UI-009, PERSIST-002 |
| S9 | GlobalSettings: Open logs folder | E2E_REQUIRED | UI-010 |
| S10 | GlobalSettings (client): Trust downloads automatically | E2E_REQUIRED | UI-011 |
| S11 | GlobalSettings (client): qbit WebUI URL + API key + download dir + Save receiver settings | E2E_REQUIRED | UI-012..014 |
| S12 | GlobalSettings (client): received queue Refresh / Download / Decline / empty state | E2E_REQUIRED | INT-030..033 |
| S13 | Window close hides to tray (resident); tray Exit quits | E2E_REQUIRED | LIFE-005..006 |
| S14 | Tray "Open Viking Relay" shows window; status label idle/transferring | E2E_REQUIRED | LIFE-007 |
| S15 | Preload-missing error screen | LOWER_LEVEL_ONLY_WITH_JUSTIFICATION (requires launching renderer without preload; covered indirectly by bridge contract tests) | — |
| S16 | Loading… placeholder before getState resolves | COVERED_BY_PARENT_FLOW (asserted in harness sanity) | SANITY-001 |
| S17 | Dark/light theme class sync from OS | OUT_OF_SCOPE_WITH_EXPLICIT_REASON (OS theme switching cannot be driven reliably from Playwright; class toggle logic trivial) | — |

## 2. Client mode

| # | Surface | Disposition | Tests |
|---|---|---|---|
| C1 | ConnectScreen: host/port/code inputs; Pair & Connect; inline errors | E2E_REQUIRED | AUTH-001..006 |
| C2 | ConnectScreen: saved connection → "Save & Reconnect" + Cancel | E2E_REQUIRED | AUTH-007..008 |
| C3 | Connection status polling; disconnected banner/reconnect | E2E_REQUIRED | STATE-010..012 |
| C4 | Forget connection | E2E_REQUIRED | AUTH-009 |
| C5 | HomeScreen: magnet/infohash/URL intake input + submit | E2E_REQUIRED | CORE-001..006 |
| C6 | HomeScreen: input validation matrix (empty/ws/unicode/oversize/non-torrent) | E2E_REQUIRED | DATA-001..010 |
| C7 | MetadataScreen: loading state, cancel during metadata | E2E_REQUIRED | STATE-001..002 |
| C8 | Metadata failure error surface + back | E2E_REQUIRED | FAIL-001..002 |
| C9 | SelectionScreen: FileTree render, tri-state checkboxes, expand/collapse | E2E_REQUIRED | UI-020..024 |
| C10 | SelectionScreen: filter files input incl. no-match state | E2E_REQUIRED | UI-025..026 |
| C11 | Select all / select none | E2E_REQUIRED | UI-027 |
| C12 | Cleanup checkboxes (torrent/files/zip) + persistence into job | E2E_REQUIRED | UI-028, CORE-010 |
| C13 | Continue to preflight disabled without selection | E2E_REQUIRED | UI-029 |
| C14 | Preflight storage warning/error surfaces; blocked start | E2E_REQUIRED | FAIL-010..012 |
| C15 | Start job → ActiveJobScreen stage pipeline (DOWNLOAD/PACKAGE/UPLOAD) | E2E_REQUIRED | CORE-020..024 |
| C16 | ActiveJob progress/telemetry (speed/eta/seeds), speed advisories | E2E_REQUIRED | CORE-025, UI-030 |
| C17 | Cancel active job (each stage) | E2E_REQUIRED | STATE-020..023 |
| C18 | Retry Packaging / Retry Upload buttons (failure + success paths) | E2E_REQUIRED | FAIL-020..023 |
| C19 | CompleteScreen: URL display, Copy URL (feedback clears ~2 s), Open page | E2E_REQUIRED | CORE-030..032 |
| C20 | CompleteScreen: direct-link copy/open buttons | E2E_REQUIRED | CORE-033 |
| C21 | ErrorScreen: title/detail, retry buttons, "Start a new torrent" | E2E_REQUIRED | FAIL-030 |
| C22 | HistoryScreen: entries, copy URL per entry, empty state, close | E2E_REQUIRED | HIST-001..004 |
| C23 | Friends: add friend modal (confirm/cancel), list, select, remove | E2E_REQUIRED | MULTI-010..014 |
| C24 | Send-to-friend panel: source input + client select + send | E2E_REQUIRED | MULTI-015..017 |
| C25 | Direct-download inbox (accept→download lands, decline, auto-accept setting) | E2E_REQUIRED | INT-040..044 |
| C26 | Duplicate torrent intake handling (`duplicate_torrent`) | E2E_REQUIRED | DATA-020 |
| C27 | Clipboard copy via bridge | E2E_REQUIRED | UI-040 |

## 3. Server mode

| # | Surface | Disposition | Tests |
|---|---|---|---|
| V1 | SetupWizard step navigation (Next/Back/GOTO rules) | E2E_REQUIRED | SETUP-001..005 |
| V2 | Step Folder: path input, Apply, status (writable/drive), invalid path errors | E2E_REQUIRED | SETUP-010..013 |
| V3 | Step Radmin: candidate list, refresh, pin selection requirement | E2E_REQUIRED | SETUP-020..022 |
| V4 | Step qBittorrent: URL+key, Save and test, unsupported-version rejection | E2E_REQUIRED | SETUP-030..033 |
| V5 | Step Viking: anonymous vs user-hash radio, save hash, test | E2E_REQUIRED | SETUP-040..042 |
| V6 | Step Ready: completion guards, Finish → dashboard | E2E_REQUIRED | SETUP-050 |
| V7 | Dashboard health banners (relay online/offline/degraded) | E2E_REQUIRED | STATE-030..032 |
| V8 | Start/Stop server controls + health snapshot | E2E_REQUIRED | CORE-040..041 |
| V9 | PairingModal: generate/regenerate code, TTL countdown, paired-client list | E2E_REQUIRED | AUTH-020..023 |
| V10 | Revoke paired client; revoked client gets 401 | E2E_REQUIRED | PERM-001..002 |
| V11 | ActiveTransferCard: live progress, stages, cancel | E2E_REQUIRED | CORE-050..052 |
| V12 | StorageCard: volume/free space display | COVERED_BY_PARENT_FLOW (asserted during J1 journey) | CORE-020 |
| V13 | HistoryList: entries, copy/open normal+direct URLs, expand error cause | E2E_REQUIRED | HIST-010..013 |
| V14 | Archive/unarchive + Show archived filter | E2E_REQUIRED | HIST-014..015 |
| V15 | Interrupted-job banner: dismiss / clean data / open qbit | E2E_REQUIRED | PERSIST-020..022 |
| V16 | SendDirectModal: target select, source input, send, empty-source disable | E2E_REQUIRED | MULTI-020..022 |
| V17 | SettingsPanel: working folder, relay port, qbit url/key save, viking hash save | E2E_REQUIRED | SET-001..005 |
| V18 | SettingsPanel: behavior checkboxes (sleep/cleanup x3) persisted | E2E_REQUIRED | SET-006..007 |
| V19 | SettingsPanel: check/install updates section | E2E_REQUIRED | SET-008 |
| V20 | Exit flow: exit button → confirm dialog → app quits; cancel path | E2E_REQUIRED | LIFE-010..011 |
| V21 | Reset profile (confirmation; wipes server config) | E2E_REQUIRED | SET-010..011 |
| V22 | Open qBittorrent WebUI (external browser handoff) | PLATFORM_UNAUTOMATABLE_WITH_EVIDENCE (shell.openExternal hands to OS browser; verified refusal logic at unit tier; E2E asserts IPC resolves) | SET-012 |
| V23 | Relay adapter-loss watcher (unavailable → rebind on return) | LOWER_LEVEL_ONLY_WITH_JUSTIFICATION (timing tied to OS adapter flaps; logic unit-tested in relay lifecycle tests; E2E covers bind/unavailable states via bad pin) | STATE-033 |

## 4. Relay HTTP API (Tier 2 real-HTTP contract)

Pair/auth/rate-limit/intakes/jobs/history/direct-jobs/status endpoints:
INT-001..029 (see plan). Disposition: E2E_REQUIRED against the REAL running relay
(launched inside the Electron app instance).

## 5. Non-UI behaviors with user impact

| # | Surface | Disposition | Tests |
|---|---|---|---|
| N1 | Job history JSON atomic persistence + restart survival | E2E_REQUIRED | PERSIST-010..012 |
| N2 | Secrets DPAPI round-trip across restart | E2E_REQUIRED | PERSIST-013 |
| N3 | Startup interrupted sweep for in-flight jobs | E2E_REQUIRED | PERSIST-020 |
| N4 | Idempotency keys on intakes/jobs | E2E_REQUIRED | DATA-030 |
| N5 | Rate limiting (per-IP 429 + Retry-After) | E2E_REQUIRED | FAIL-040 |
| N6 | Updater disabled-in-dev flag | E2E_REQUIRED | UI-006 |
| N7 | Viking direct-link resolver window (#download-link poll, 90 s timeout) | PLATFORM_UNAUTOMATABLE_WITH_EVIDENCE (opens visible BrowserWindow for manual CAPTCHA; automated only up to window-open assertion; core polling logic unit-tested) | EXT-001 |
| N8 | Login-item sync on startWithWindows change | LOWER_LEVEL_ONLY_WITH_JUSTIFICATION (OS registry write; asserted via settings persistence + no-error; actual registry effect out of scope to avoid mutating user machine) | UI-008 |
| N9 | PowerSaveBlocker during transfers | OUT_OF_SCOPE_WITH_EXPLICIT_REASON (no observable user-visible contract; OS power behavior unverifiable in tests) | — |

## 6. Counts

- Shell: 17 surfaces · Client: 27 · Server: 23 · HTTP API groups: 8 · Non-UI: 9 → **84 inventoried**
- E2E_REQUIRED: 68 · COVERED_BY_PARENT_FLOW: 3 · LOWER_LEVEL_ONLY: 4 · PLATFORM_UNAUTOMATABLE: 2 · OUT_OF_SCOPE: 3 · RETIRED/UNREACHABLE: 0
- No surface left UNKNOWN.
