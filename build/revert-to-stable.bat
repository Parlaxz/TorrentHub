@echo off
setlocal EnableDelayedExpansion
rem Rolls Viking Relay back from a BETA to the latest STABLE release.
rem Uses the app's built-in differential updater - only changed blocks are
rem downloaded. No window is opened; the app installs and relaunches itself.

set "APPDIR=%~dp0.."
set "EXE=%APPDIR%\Viking Relay.exe"

if not exist "%EXE%" (
  echo [rollback] ERROR: "Viking Relay.exe" not found at:
  echo   %EXE%
  echo Install Viking Relay first ^(or fix this script's APPDIR^).
  pause & exit /b 1
)

echo [rollback] closing Viking Relay if it is running...
taskkill /FI "IMAGENAME eq Viking Relay.exe" /F >nul 2>&1
timeout /t 2 /nobreak >nul

echo [rollback] fetching latest STABLE via differential download...
echo [rollback] ^(no window will open - this can take a moment^)
"%EXE%" --rollback-stable
set "RC=%ERRORLEVEL%"

if "%RC%"=="0" (
  echo [rollback] SUCCESS - Viking Relay has been reverted to stable.
) else (
  echo [rollback] FAILED ^(exit code %RC%^).
  echo [rollback] Manual fallback: download the latest stable installer from
  echo   https://github.com/Parlaxz/TorrentHub/releases/latest
  echo   ^(the file named Viking-Relay-Setup-x.y.z.exe without "beta"^)
)
pause
exit /b %RC%
