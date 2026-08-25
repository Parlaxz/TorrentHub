# E2E Exhaustive Test Plan — Viking Relay v0.4.3

Permanent test IDs. Never renumber. Statuses: `planned → pass | fail(A/B/C/D/E) | skip(D/E)`.

Tiers: **T1** deterministic E2E (real UI + local mocks), **T2** local-real (real relay/engine/persistence
inside real app instances; external systems mocked at wire level), **T3** true-external (none — see
`E2E-PLATFORM-LIMITATIONS.md` §Viking).

## Lane map (spec files)

| Spec file | Lanes |
|---|---|
| `sanity.spec.ts` | SANITY |
| `lifecycle.spec.ts` | LIFE, NAV |
| `shell-settings.spec.ts` | UI (shell/global settings), SET (server settings) |
| `setup-wizard.spec.ts` | SETUP |
| `auth-pairing.spec.ts` | AUTH, PERM |
| `core-journey.spec.ts` | CORE (J1/J2 happy pipeline both UIs) |
| `job-states.spec.ts` | STATE (cancel/race/stage transitions) |
| `failures.spec.ts` | FAIL (qbit/viking/storage/ratelimit error paths) |
| `history-archive.spec.ts` | HIST |
| `data-inputs.spec.ts` | DATA (input matrices, idempotency, duplicates) |
| `relay-api.spec.ts` | INT (real HTTP contract vs running relay) |
| `multi-instance.spec.ts` | MULTI (friends, direct-send, direct-download inbox) |
| `persistence.spec.ts` | PERSIST (restart/recovery/interrupted sweep) |
| `ui-sweep.spec.ts` | UISWEEP (machine-readable control inventory cross-check) |
| `a11y.spec.ts` | A11Y |

## Coverage matrix

### SANITY (harness)
| ID | Surface | Assertion | Tier | Status |
|---|---|---|---|---|
| SANITY-001..004 | harness | launch/readiness/artifacts/isolation/collectors | T1 | PASS |

### LIFE / NAV
| ID | Surface | Action → expected | Tier | Status |
|---|---|---|---|---|
| LIFE-001 | ModeChooser | fresh launch shows chooser; versions correct | T1 | planned |
| LIFE-002 | ModeChooser | choose Client → client app mounts | T1 | planned |
| LIFE-003 | ModeChooser | choose Server → server app mounts | T1 | planned |
| LIFE-004 | Header badge | badge reflects mode (`client`/`server`/`unconfigured`) | T1 | planned |
| LIFE-005 | Window close | close hides to tray (process alive, window hidden) | T1 | planned |
| LIFE-006 | Tray Exit | tray menu Exit quits process cleanly | T1 | planned |
| LIFE-007 | Tray open/status | Open Viking Relay re-shows window; status label idle/transferring | T1 | planned |
| LIFE-010 | Server exit flow | exit button → confirm dialog → process exits; cancel keeps alive | T2 | planned |
| LIFE-011 | --hidden launch | starts with no visible window (login-item path) | T1 | planned |
| NAV-001 | Switch mode | client→server→client round trip preserves backends | T1 | planned |
| NAV-002 | Switch mode | switch during active client screen returns to chooser-free mount | T1 | planned |

### UI shell / global settings
| ID | Surface | Action → expected | Tier | Status |
|---|---|---|---|---|
| UI-001..004 | GlobalSettingsModal | open via ⚙; close via button/backdrop/Escape | T1 | planned |
| UI-005..007 | Updates section | dev build ⇒ disabled flag true; check-for-updates resolves not-available/error without crash | T1 | planned |
| UI-008 | Start with Windows | toggle persists to settings.json | T1 | planned |
| UI-009 | Minimize to tray | toggle persists; close behavior follows setting | T1 | planned |
| UI-010 | Open logs folder | IPC resolves true; logs dir exists on disk | T1 | planned |
| UI-011..014 | Client receiver settings | auto-accept/qbit url/key/download-dir save → persisted + qbitKeySet flips | T1 | planned |
| UI-020..029 | SelectionScreen controls | tree expand/collapse, tri-state checkboxes, filter incl no-match, select all/none, cleanup flags, continue gating | T2 | planned |
| UI-030 | Speed advisories | waiting_for_peers advisory renders under zero-seed scenario | T2 | planned |
| UI-040 | Clipboard | copy buttons write expected text to system clipboard | T1 | planned |

### SETUP wizard
| ID | Surface | Action → expected | Tier | Status |
|---|---|---|---|---|
| SETUP-001..005 | Wizard nav | Next/Back/GOTO rules; cannot jump ahead; Ready gated | T1 | planned |
| SETUP-010..013 | Folder step | apply valid path → writable+drive ok; invalid path errors; empty rejected | T1 | planned |
| SETUP-020..022 | Radmin step | candidates listed from real NICs; pin selection recorded; refresh works | T1 | planned |
| SETUP-030..033 | qBittorrent step | probe ok against mock (≥5.2); unsupported version rejected; bad URL error; key saved | T1 | planned |
| SETUP-040..042 | Viking step | anonymous accepted; user-hash saved; invalid hash handled | T1 | planned |
| SETUP-050 | Ready step | finish → Dashboard mounts | T1 | planned |

### AUTH / PERM
| ID | Surface | Action → expected | Tier | Status |
|---|---|---|---|---|
| AUTH-001 | Pairing happy path | client pairs via UI against live relay → connected home | T2 | planned |
| AUTH-002 | Wrong code | pairing fails with truthful inline error | T2 | planned |
| AUTH-003 | Malformed code | 8-char rule enforced client-side | T1 | planned |
| AUTH-004 | Bad host | unreachable host → server_unreachable error surface | T2 | planned |
| AUTH-005 | Invalid port | port validation messages | T1 | planned |
| AUTH-006 | Code normalization | `xxxx-xxxx` lowercase+dashes accepted | T2 | planned |
| AUTH-007 | Saved connection reconnect | Save & Reconnect path | T2 | planned |
| AUTH-008 | Cancel change-server | Back keeps existing connection | T1 | planned |
| AUTH-009 | Forget connection | returns to Connect screen; token cleared | T2 | planned |
| AUTH-020..023 | PairingModal | generate/regenerate code; TTL display; paired list updates | T2 | planned |
| PERM-001 | Revoke client | revoked client's next request → 401 surfaced as disconnected | T2 | planned |
| PERM-002 | Tenant isolation | client A's jobs invisible to client B beyond roster rules | T2 | planned |

### CORE journeys (T2)
| ID | Journey | Status |
|---|---|---|
| CORE-001..006 | intake create (magnet/infohash/url variants) → metadata draft | planned |
| CORE-010 | selection commit w/ cleanup flags reaches queued | planned |
| CORE-020..024 | full J1: download(mock)→package(ZIP)→upload(mock viking)→complete URL on BOTH UIs | planned |
| CORE-025 | telemetry fields update during download | planned |
| CORE-030..033 | CompleteScreen URL copy/open/direct-link actions | planned |
| CORE-040..041 | server Start/Stop controls + health snapshot | planned |
| CORE-050..052 | ActiveTransferCard mirrors job; cancel from server side | planned |

### STATE transitions
| ID | Scenario | Status |
|---|---|---|
| STATE-001..002 | metadata loading; cancel during metadata | planned |
| STATE-010..012 | connection polling; server stop → disconnected banner; restart → reconnect | planned |
| STATE-020..023 | cancel during download/package/upload(+finalizing race) | planned |
| STATE-030..033 | dashboard banners: online/offline/bind-error(unavailable) states | planned |

### FAIL paths
| ID | Scenario | Expected | Status |
|---|---|---|---|
| FAIL-001..002 | metadata fetch 500 / timeout | failed intake w/ truthful error, retry possible | planned |
| FAIL-010..012 | storage preflight: huge torrent vs free space → blocked start; warning band | planned |
| FAIL-020..023 | packaging failure → Retry Packaging succeeds; upload permanent fail → terminal; upload transient fail → retry succeeds | planned |
| FAIL-030 | ErrorScreen taxonomy rendering (bad_torrent etc.) | planned |
| FAIL-040 | rate limit: >10 pair attempts/IP → 429 w/ Retry-After surfaced | planned |
| FAIL-041 | qbit down at start-server time → health degraded/banners | planned |
| FAIL-042 | duplicate torrent → duplicate_torrent error | planned |

### HIST
| ID | Scenario | Status |
|---|---|---|
| HIST-001..004 | client history entries/copy/empty/close | planned |
| HIST-010..013 | server history copy/open normal+direct URLs; expand error cause | planned |
| HIST-014..015 | archive/unarchive + Show archived filter | planned |

### DATA inputs
| ID | Matrix | Status |
|---|---|---|
| DATA-001..010 | intake input matrix (empty/ws/unicode/emoji/newline/reserved chars/oversize/non-torrent/http-url/malformed magnet) | planned |
| DATA-020 | duplicate_torrent second submission | planned |
| DATA-030 | idempotency keys prevent duplicate intakes/jobs (double-submit race) | planned |
| DATA-031 | friend name/clientId input edge cases | planned |

### INT relay API (T2, real HTTP against running relay)
| ID | Endpoint group | Status |
|---|---|---|
| INT-001..005 | health/pair/auth-guard(401)/pair schema violations/expired-code(410) | planned |
| INT-010..016 | intakes+jobs CRUD via raw HTTP incl. selection limits (index bounds, 10k cap) | planned |
| INT-020..024 | history limit bounds; server/status; clients roster | planned |
| INT-030..033 | direct-jobs queue/accept/decline via API + client inbox UI | planned |
| INT-040..044 | client direct-download inbox: accept downloads file to folder; decline removes; auto-accept honors setting | planned |

### MULTI
| ID | Scenario | Status |
|---|---|---|
| MULTI-010..014 | friends add/list/select/remove (+empty states) | planned |
| MULTI-015..017 | send-to-friend panel: send happy path; empty-source disabled; unknown target error | planned |
| MULTI-020..022 | SendDirectModal: send lands in recipient inbox; disable when busy; close/cancel | planned |

### PERSIST
| ID | Scenario | Status |
|---|---|---|
| PERSIST-001 | mode persists across restart | planned |
| PERSIST-002 | minimize-to-tray=false → close really quits | planned |
| PERSIST-010..012 | completed job survives restart (history JSON); workspace cleanup honored | planned |
| PERSIST-013 | secrets survive restart (paired client reconnects without re-pair) | planned |
| PERSIST-020 | kill mid-job → restart → interrupted banner; dismiss/clean-data work | planned |
| PERSIST-021 | cancelled-before-restart job stays cancelled after restart | planned |
| PERSIST-022 | corrupt settings.json → app boots on defaults (fails safe) | planned |

### UISWEEP / A11Y
| ID | Scenario | Status |
|---|---|---|
| UISWEEP-001..N | per mounted screen: enumerate interactive controls; assert each maps to a test or documented disposition | planned |
| A11Y-001..006 | modal Escape/focus-trap/backdrop; aria labels on critical controls; disabled state semantics; tab order on connect form | planned |

## Counts
Permanent IDs planned: **~140** across 15 lanes. Every inventory item in
`E2E-PRODUCT-SURFACE-INVENTORY.md` maps to ≥1 ID above or carries an explicit disposition there.
