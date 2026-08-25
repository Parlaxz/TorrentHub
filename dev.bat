@echo off
setlocal
cd /d "C:\Users\parla\OneDrive\Documents\Development\TorrentHub" || (echo [error] repo not found & exit /b 1)

rem NOTE: every npm invocation MUST use "call" - without it, control jumps
rem into npm.cmd and never returns, so the rest of the script never runs.

if not exist node_modules (
  echo [deps] node_modules missing - installing...
  call npm install || (echo [error] npm install failed & exit /b 1)
)

echo [dev] starting electron-vite dev (builds main/preload/renderer, launches app)...
call npm run dev
