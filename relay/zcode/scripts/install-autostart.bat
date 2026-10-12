@echo off
REM install-autostart.bat -- register the logon scheduled task for the zcode companion.
REM
REM Creates scheduled task "wzxClawZcodeCompanion": at every logon of the
REM current user, wscript.exe runs companion-autostart.vbs (hidden window).
REM Idempotent: an existing task with the same name is deleted first, so this
REM script can be re-run after editing the VBS.
REM No working directory is needed on the task itself -- the VBS resolves every
REM path relative to its own location and sets the companion cwd itself.
REM NOTE: registering a logon task needs an elevated token, so this script
REM relaunches itself as administrator (one UAC prompt) when needed.
setlocal

set "TASKNAME=wzxClawZcodeCompanion"
set "VBS=%~dp0companion-autostart.vbs"

if not exist "%VBS%" (
  echo [install-autostart] ERROR: companion-autostart.vbs not found next to this script.
  exit /b 1
)

REM Elevate when not started as administrator.
net session >nul 2>&1
if errorlevel 1 (
  echo [install-autostart] Registering a logon task needs administrator rights.
  echo [install-autostart] Accept the UAC prompt to continue...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

REM Drop any previous registration; "task not found" errors are ignored.
schtasks /delete /tn "%TASKNAME%" /f >nul 2>&1

schtasks /create /tn "%TASKNAME%" /tr "wscript.exe \"%VBS%\"" /sc onlogon /rl limited /f
if errorlevel 1 (
  echo [install-autostart] ERROR: schtasks failed to create the task.
  exit /b 1
)

echo [install-autostart] Task "%TASKNAME%" created: the companion starts hidden at every logon.
echo [install-autostart] Log file: %%USERPROFILE%%\.wzxclaw\zcode-companion\autostart.log
echo [install-autostart] Start it now without re-logging: schtasks /run /tn "%TASKNAME%"
echo [install-autostart] To remove autostart, run: uninstall-autostart.bat
pause
