@echo off

echo ========================================
echo   wzxClaw Android Build
echo ========================================
echo.

set JAVA_HOME=C:\Users\67376\jdk17\jdk-17.0.18+8

echo Building APK...
call C:\Users\67376\flutter\bin\flutter build apk --release
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Done!
echo ========================================
echo.
echo Output: build\app\outputs\flutter-apk\app-release.apk
echo.
call explorer "%~dp0build\app\outputs\flutter-apk"
pause
