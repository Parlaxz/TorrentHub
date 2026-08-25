# E2E Platform Limitations

Truthful record of what cannot be automated in this environment, with evidence and the
smallest remaining manual verification.

| # | Limitation | Evidence | Automated portion | Remaining manual step |
|---|---|---|---|---|
| P1 | **True-external Viking uploads skipped (Tier 3)**: uploading test junk to vikingfile.com creates public third-party artifacts; not economically/sanitarily warranted per-test | docs/E2E-ARCHITECTURE-MAP.md §6 | Wire-level local Viking mock exercises the REAL multipart client, retry/backoff, completion, check-file paths (Tier 2) | Periodic manual smoke against real vikingfile.com before releases |
| P2 | **Tray context-menu interaction** (win32 Tray + Menu): Playwright cannot click OS tray menus reliably | src/main/index.ts createTray(); tray existence asserted via absence of 'tray icon unavailable' in main stdout during tests | Tray creation, icon path resolution, resident-close behavior (process alive, window hidden), Exit via app.quit() path all covered | Manual: right-click tray → Open/Exit once per release |
| P3 | **Viking direct-link resolver window** opens a visible BrowserWindow intended for manual CAPTCHA (#download-link poll, 90 s timeout) | src/main/viking/direct-link-window.ts | Window-open assertion + core polling logic covered at unit tier | Manual: real direct-link fetch behind CAPTCHA |
| P4 | **OS dark/light theme switch** cannot be driven from Playwright deterministically | src/main/index.ts syncThemeClass() | Class-toggle logic trivial; nativeTheme event is OS-driven | Manual visual check optional |
| P5 | **Windows login-item registry effect** (startWithWindows): writing HKCU Run keys mutates the user's real machine state; tests assert settings persistence + IPC success only | src/main/login-item.ts | Toggle persistence + no-error assertions (UI-008) | Manual: verify Task Manager > Startup apps after toggling |
| P6 | **shell.openExternal targets** (logs folder, qbit WebUI, external URLs): OS browser/explorer handoff is outside the app boundary | src/main/ipc.ts openLogsFolder/openExternal | Promise-resolution + refusal-of-non-http(s) logic verified; no page errors | Manual spot-check |
| P7 | **Electron safeStorage ciphertext is bound to the userData directory** (verified Electron 43/Windows): copying secrets.json to a fresh userData dir makes decryption impossible ("Error while decrypting the ciphertext…"). Real-user restarts reuse the same dir and are unaffected | PERSIST-013 investigation artifacts (relaunched-instance log: repeated decrypt failures) | True-restart tests relaunch on the SAME dir via launchApp `userDataDir` override; secret round-trip verified there (PERSIST-013 green) | None — platform behavior, documented for future migration features |
