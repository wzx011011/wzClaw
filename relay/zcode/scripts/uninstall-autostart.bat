@echo off
REM uninstall-autostart.bat -- remove the zcode companion logon scheduled task.
REM This only removes autostart. A companion that is already running keeps
REM running until you log off or kill its node.exe process yourself.
REM NOTE: deleting the task needs an elevated token, so this script relaunches
REM itself as administrator (one UAC prompt) when needed.
setlocal

set "TASKNAME=wzxClawZcodeCompanion"

REM Elevate when not started as administrator.
net session >nul 2>&1
if errorlevel 1 (
  echo [uninstall-autostart] Removing the task needs administrator rights.
  echo [uninstall-autostart] Accept the UAC prompt to continue...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

schtasks /delete /tn "%TASKNAME%" /f
if errorlevel 1 (
  echo [uninstall-autostart] Task "%TASKNAME%" was not registered ^(nothing removed^).
  exit /b 1
)

echo [uninstall-autostart] Task "%TASKNAME%" removed. The companion will not autostart anymore.
pause
