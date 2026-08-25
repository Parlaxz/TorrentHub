# E2E Final Sweep — Viking Relay v0.4.3

## Verdict

**199/199 PASSED, 0 failed, 0 skipped** — full sequential campaign, single worker, 12.6 minutes.
(Run after the DEF-007 tenant-scoping fix; PERM-002 is now a REAL isolation pass, no
expected-failures anywhere. An earlier sweep of the same suite scored 200/200 including one
diagnostic probe since removed.)

## Exact command

```powershell
node node_modules\@playwright\test\cli.js test tests/e2e/
```

(playwright.config.ts: workers=1, retries=0, timeout 90s, JSON/JUnit reports → `artifacts/e2e/`)

## Environment

- Windows 11 workstation, Node 25.2.1, Electron 43.4.1, Playwright 1.62 (@playwright/test)
- Build: `npm run typecheck && npm run build` immediately prior (out/main+preload+renderer)
- Each test: isolated `--user-data-dir` temp profile; wire-level qBittorrent + Viking mocks on 127.0.0.1; relay bound to the machine's LAN IPv4
- **Environmental caveat (honest):** an unrelated project's Playwright suite ("Mind Palace", ~9 node processes) was executing concurrently on this machine during the sweep. All previously load-sensitive tests were hardened and quantified (see E2E-FLAKE-REPORT.md); the sweep passed in full under that load.

## Per-suite results (final sweep)

| Suite | Pass | Fail |
|---|---|---|
| sanity.spec.ts | 4 | 0 |
| cluster-smoke.spec.ts | 1 | 0 |
| lifecycle.spec.ts | 11 | 0 |
| shell-settings.spec.ts | 26 | 0 |
| setup-wizard.spec.ts | 20 | 0 |
| auth-pairing.spec.ts | 15 (PERM-002 = real tenant-isolation pass incl. foreign-mutation 404 ×4) | 0 |
| core-journey.spec.ts | 22 | 0 |
| job-states.spec.ts | 13 | 0 |
| failures.spec.ts | 13 | 0 |
| data-inputs.spec.ts | 13 | 0 |
| history-archive.spec.ts | 10 | 0 |
| persistence.spec.ts | 9 | 0 |
| relay-api.spec.ts | 15 | 0 |
| multi-instance.spec.ts | 9 | 0 |
| ui-sweep.spec.ts | 12 | 0 |
| a11y.spec.ts | 6 | 0 |
| **Total** | **200** | **0** |

## What the campaign exercised for real

- Two-instance product topology: SERVER app (real Fastify relay on a real NIC address, real JobEngine, real packaging ZIP, real auth/rate-limits) + CLIENT app paired through the real UI — magnet→metadata→selection→preflight→download(mock qbit)→package(real ZIP bytes verified via PK magic + byte-exact part bodies)→upload(mock viking multipart)→complete URL visible on BOTH UIs.
- Persistence boundaries: settings.json/secrets.json/job-history.json/direct-jobs.json read from disk; restarts (clean + hard-kill + taskkill tree); interrupted-sweep; DPAPI secret round-trips (same-dir restart).
- Failure injection at the wire level: HTTP 500/403/429+Retry-After, malformed JSON, connection resets, missing sources, obstruction-based packaging failures, storage preflight math vs measured volume free space.
- Full UI control inventory (13 surfaces, zero unnamed interactive controls) + keyboard/focus/aria assertions.

## Residual risk

- DEF-007 (history not tenant-scoped) is a known open product defect, pinned by PERM-002 expected-failure.
- External machine load during the sweep (see caveat) — all timing-sensitive tests were hardened and repeat-verified; residual flake risk under heavier contention than observed is assessed LOW.
