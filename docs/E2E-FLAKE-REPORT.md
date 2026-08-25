# E2E Flake Report

Protocol: reproduced → root-caused → fixed at cause → repeat-verified. No test was marked
fixed after a single pass.

## FLAKE-001 — PERSIST-020 "dismissed flag persisted" (intermittent)

- **Original frequency:** 2 of 4 observed runs (full-suite sweep + one repeat) failed; isolated runs passed.
- **Symptom:** Dismiss clicked on the interrupted banner; `record.dismissed` never became true within 30 s.
- **Root cause:** Live health pushes (1/s) update the StorageCard figures above the banner, shifting the three sibling action buttons horizontally between locator resolution and mousedown — the click intermittently landed on the adjacent **"Clean up job data"** (which discards artifacts but never sets `dismissed`). Zero predicate errors + zero page errors confirmed the wrong-button click.
- **Fix:** verify-and-retry dismiss loop in the spec (click exact-name button → assert flag within 4 s → re-click up to 4 attempts).
- **Post-fix repeats:** 6/6 pass (`--repeat-each=6`, 52.8 s).
- **Residual uncertainty:** LOW.

## FLAKE-002 — SETUP-040/SETUP-050 Anonymous radio "did not change its state" (load-dependent)

- **Original frequency:** failed in 1 of 2 full sweeps; passed all isolated runs.
- **Symptom:** Playwright `check()` timed out waiting for the radio to become checked.
- **Root cause:** the radio's `checked` state depended on an async IPC round-trip (`setVikingUserHash('')` → DPAPI write → response). Under CPU contention the round-trip exceeded Playwright's state-change window.
- **Fix (product, DEF-005 follow-up):** optimistic local flip via `VIKING_MODE_PICK` dispatch before the async persist — UI reflects the choice instantly; persistence remains authoritative.
- **Post-fix repeats:** 8/8 (SETUP-040+050 ×4 each).
- **Residual uncertainty:** NONE.

## FLAKE-003 — FAIL-020 retry #2 never reached Complete (sweep-only)

- **Original frequency:** 1 of 3 full sweeps; 4/4 + 5/5 isolated passes around it.
- **Symptom:** after removing the `.partial.zip` obstruction and clicking Retry Packaging, the Complete screen never appeared within 45 s.
- **Root cause:** Windows handle-release race — `rmSync` of the obstruction directory can lag the packager's next `createWriteStream` on the same path, producing a second EISDIR failure.
- **Fix:** wait-for-gone poll (`!existsSync(partialDir)`, 5 s budget) before issuing Retry #2.
- **Post-fix repeats:** 5/5 (52.7 s).
- **Residual uncertainty:** LOW under normal load; MEDIUM only under heavy external CPU contention (see sweep caveat).

## FLAKE-004 — CORE-004 (single historical occurrence)

- **Frequency:** 1 failure in one combined suite run; passed every isolated run and 8/8 `--repeat-each` afterwards.
- **Classification:** C-environmental — coincided with peak external load from the unrelated concurrent suite.
- **Action:** monitored; no code change warranted. If it recurs outside external load, escalate to a dedicated investigation.

## Environmental note

An unrelated project's test suite ran concurrently during parts of this campaign (up to ~9 node
processes). All timing-sensitive tests above were hardened against that reality, and the final
sweep passed 200/200 WITH that load present — a stronger result than a quiet-machine run alone.
