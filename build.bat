@echo off
chcp 65001 >nul 2>&1
setlocal

echo ========================================
echo   wzxClaw Build Script
echo ========================================
echo.

:: Check if wzxClaw.exe is running
tasklist /FI "IMAGENAME eq wzxClaw.exe" 2>NUL | find /I /N "wzxClaw.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo [ERROR] wzxClaw.exe is running. Please close it first.
    echo.
    choice /C YN /M "Kill wzxClaw.exe now"
    if errorlevel 2 (
        echo Aborted.
        pause
        exit /b 1
    )
    taskkill /F /IM wzxClaw.exe >nul 2>&1
    timeout /t 2 /nobreak >nul
    echo Killed.
    echo.
)

echo [1/2] Building (electron-vite build)...
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo.
echo [2/2] Packaging (electron-builder --win)...
call npx electron-builder --win
if errorlevel 1 (
    echo.
    echo [ERROR] Packaging failed.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Done!
echo ========================================
echo.
echo Output: dist\wzxClaw Setup *.exe
echo.
dir /b dist\wzxClaw*.exe 2>nul
echo.
explorer "%~dp0dist"
pause
