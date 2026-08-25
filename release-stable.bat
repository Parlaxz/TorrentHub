@echo off
rem One-command STABLE release: promotes the current beta (strips the
rem prerelease suffix) or bumps the patch version, builds and publishes.
rem Requires GH_TOKEN in the environment.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release.ps1" -Channel stable -Publish %*
