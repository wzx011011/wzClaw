@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

:: Always run from script directory
cd /d "%~dp0"

echo ========================================
echo   wzxClaw Build Script (Safe)
echo ========================================
echo [INFO] Working directory: %cd%
echo.

if not exist package.json (
    echo [ERROR] package.json not found. Please run this script in wzxClaw_desktop.
    pause
    exit /b 1
)

:: Check if wzxClaw.exe is running
tasklist /FI "IMAGENAME eq wzxClaw.exe" 2>nul | find /I "wzxClaw.exe" >nul
if "%ERRORLEVEL%"=="0" (
    echo [WARN] wzxClaw.exe is running.
    choice /C YN /M "Kill wzxClaw.exe now"
    if errorlevel 2 (
        echo [ERROR] Aborted by user.
        pause
        exit /b 1
    )
    taskkill /F /IM wzxClaw.exe >nul 2>&1
    timeout /t 2 /nobreak >nul
    echo [OK] wzxClaw.exe killed.
    echo.
)

:: Ensure local dependencies exist
if not exist node_modules (
    echo [INFO] node_modules not found, installing dependencies...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo [1/2] Building renderer/main/preload (electron-vite build)...
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed.
    echo [TIP] Check TypeScript/Vite errors above.
    pause
    exit /b 1
)

echo.
echo [2/2] Packaging installer (electron-builder --win)...
if exist "node_modules\.bin\electron-builder.cmd" (
    call "node_modules\.bin\electron-builder.cmd" --win
) else (
    call npx electron-builder --win
)

if errorlevel 1 (
    echo.
    echo [ERROR] Packaging failed.
    echo [TIP] If dependency resolution fails, run: npm install
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Done!
echo ========================================
echo Output files:
dir /b "dist\wzxClaw Setup *.exe" 2>nul
echo.
explorer "%cd%\dist"
pause
