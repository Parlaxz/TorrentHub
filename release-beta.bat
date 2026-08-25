@echo off
rem One-command BETA release: bumps to the next beta version, builds and
rem publishes to GitHub. Requires GH_TOKEN in the environment.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release.ps1" -Channel beta -Publish %*
