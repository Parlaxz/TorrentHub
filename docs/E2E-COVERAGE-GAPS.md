# E2E Coverage Gaps

Final state: **no unexplained gaps.** Every inventory surface maps to a passing test or a
documented disposition (see E2E-PRODUCT-SURFACE-INVENTORY.md and E2E-PLATFORM-LIMITATIONS.md).

## Intentionally accepted limitations (not gaps)

1. **True-external Viking uploads (Tier 3)** — skipped by policy; wire-level mock covers the real
   multipart client. Manual pre-release smoke recommended. (P1)
2. **Tray context-menu clicks** — win32 native menu not automatable; tray existence, resident-close,
   and quit paths covered via identical code paths. (P2)
3. **Viking direct-link CAPTCHA window** — manual-resolution window asserted open/close only;
   headless JSON contract exercised hermetically against the local front. (P3)
4. **OS theme switching / login-item registry effect / shell.openExternal OS handoff** — asserted to
   the app boundary; OS-side effects require manual spot-checks. (P4–P6)

## Known open product defect (documented, pinned)

None. DEF-007 (tenant scoping) was fixed in the follow-up pass: reads AND mutations are
client-scoped, legacy records dashboard-only, PERM-002 now asserts real isolation.

## Watch-list (non-blocking)

- STATE-001's metadata-loading branch was only intermittently observable at mock speed; the cancel/
  error paths around it are fully covered. If future slowdowns make it observable, add an explicit
  loading assertion.
- `Toggle` component drops extra props (testids in docs don't reach the DOM) — cosmetic tech-debt
  noted for the selector contract.
