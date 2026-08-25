@echo off
rem ====================================================================
rem  Viking Relay - EMERGENCY REVERT TO THE STABLE UPDATE CHANNEL
rem
rem  Ships inside the installed app at <install>\resources\. Run it by
rem  double-clicking if a beta build misbehaves and you cannot reach the
rem  in-app Settings screen. It flips updateChannel back to 'stable' in
rem  the app's settings.json, stops the running app and relaunches it.
rem ====================================================================
setlocal
set "VR_RES_DIR=%~dp0"
echo ==============================================================
echo  Viking Relay - reverting update channel to STABLE
echo ==============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $res=$env:VR_RES_DIR; $install=Split-Path -Parent $res; $cands=@((Join-Path $env:APPDATA 'Viking Relay\settings.json'),(Join-Path $env:APPDATA 'viking-relay\settings.json')); $sp=@($cands | Where-Object { Test-Path -LiteralPath $_ })[0]; if(-not $sp){ Write-Host 'ERROR: settings.json was not found.'; Write-Host 'Looked in:'; $cands | ForEach-Object { Write-Host ('  {0}' -f $_) }; Write-Host ''; Write-Host 'Fix it manually:'; Write-Host '  1. Start Viking Relay, open Settings and pick the Stable channel.'; Write-Host '  2. Or reinstall the latest stable setup from GitHub releases.'; exit 1 }; Write-Host ('Settings file : {0}' -f $sp); try { $json = Get-Content -LiteralPath $sp -Raw | ConvertFrom-Json } catch { Write-Host ('ERROR: cannot parse settings.json: {0}' -f $_.Exception.Message); Write-Host 'Fix it manually: open the file and set ''updateChannel'': ''stable''.'; exit 1 }; Copy-Item -LiteralPath $sp -Destination ($sp + '.bak') -Force; $json | Add-Member -NotePropertyName updateChannel -NotePropertyValue 'stable' -Force; $text = $json | ConvertTo-Json -Depth 32; [System.IO.File]::WriteAllText($sp, $text); Write-Host 'updateChannel is now ''stable'' (backup saved next to the file).'; $proc = @(Get-Process | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith($install.ToLower()) }); if($proc.Count -gt 0){ Write-Host 'Stopping the running Viking Relay...'; $proc | Stop-Process -Force; Start-Sleep -Seconds 2 } else { Write-Host 'Viking Relay is not currently running.' }; $exe = Join-Path $install 'Viking Relay.exe'; if(Test-Path -LiteralPath $exe){ Write-Host ('Relaunching: {0}' -f $exe); Start-Process -FilePath $exe } else { Write-Host ('Executable not found ({0}) - start Viking Relay manually.' -f $exe) }; Write-Host ''; Write-Host 'Done. The app will now receive STABLE channel updates only.'; exit 0"
echo.
echo (A backup of your previous settings.json was saved as settings.json.bak.)
pause
