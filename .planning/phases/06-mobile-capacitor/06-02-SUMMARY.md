---
phase: 06-mobile-capacitor
plan: 02
subsystem: mobile
tags: [android, icons, splash-screen, status-bar, gradle, apk-build, branding]
dependency_graph:
  requires: [mobile/, mobile/android/]
  provides: [branded-android-resources, apk-build-pipeline]
  affects: [mobile/android/app/src/main/res/, mobile/android/app/build.gradle, mobile/scripts/build.js]
tech_stack:
  added: []
  patterns: [gradle-java-compatibility-override, jdk-auto-detection]
key_files:
  created: []
  modified:
    - mobile/android/app/src/main/res/mipmap-*/ic_launcher.png (5 densities)
    - mobile/android/app/src/main/res/mipmap-*/ic_launcher_round.png (5 densities)
    - mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml
    - mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml
    - mobile/android/app/src/main/res/drawable/splash.png
    - mobile/android/app/src/main/res/values/styles.xml
    - mobile/android/app/src/main/res/values/ic_launcher_background.xml
    - mobile/android/app/build.gradle
    - mobile/android/build.gradle
    - mobile/android/variables.gradle
    - mobile/android/gradle/wrapper/gradle-wrapper.properties
    - mobile/scripts/build.js
decisions:
  - D-01: Copied Flutter app icons directly instead of generating new ones (reuses existing brand assets)
  - D-02: Adaptive icon foreground uses ic_launcher (same as background image) since Flutter icons are simple
  - D-03: Switched Gradle wrapper from 8.11.1 to 8.14 (network timeout, 8.14 already cached from Flutter builds)
  - D-04: Added allprojects subprojects override to force Java 17 compatibility (Capacitor 7 requires Java 21 but dev machine only has JDK 17)
  - D-05: APK is unsigned (app-release-unsigned.apk) since no signing keys configured; debug-signable for testing
metrics:
  duration: 28m
  completed: 2026-05-14
  tasks: 2
  files: 17
---

# Phase 6 Plan 02: Android Branding + APK Build Summary

wzxClaw Android branding with Flutter icon assets, dark splash/theme, and verified one-command APK build pipeline producing 3.26 MB release APK.

## Tasks Completed

### Task 1: Android Native Resources -- Icons + Splash + Styles

Replaced all Capacitor default icons with wzxClaw icons from the Flutter project across 5 mipmap densities (mdpi through xxxhdpi). Updated adaptive icon XML (API 26+) to reference the new icons. Created dark splash screen (#1e1e1e). Configured status bar and navigation bar colors to #1e1e1e in styles.xml, matching the web-ui dark theme. Updated launcher background color to dark. Ran `npx cap sync android` to synchronize all resources.

**Commit:** 9850ca7

### Task 2: APK Build Pipeline Verification

Configured Gradle build settings: applicationId `com.wzxclaw.mobile`, minSdk 24 (Android 7.0+), targetSdk 34, version 0.1.0. Resolved build blockers: switched Gradle wrapper to 8.14 (cached from Flutter builds, 8.11.1 had network timeout), added Java 17 compatibility override for Capacitor 7 (which requires Java 21 by default). Enhanced build.js with JDK auto-detection (falls back to known JDK 17 path), per-step timing, APK size reporting, and unsigned APK path handling. Full pipeline verified: web-ui build -> cap sync -> Gradle assembleRelease produces 3.26 MB app-release-unsigned.apk.

**Commit:** f04dc28

## Verification Results

| Check | Result |
|-------|--------|
| Gradle assembleRelease | BUILD SUCCESSFUL (269 tasks, 2m 32s) |
| APK exists | app-release-unsigned.apk (3.26 MB) |
| applicationId | com.wzxclaw.mobile |
| statusBarColor | #1e1e1e |
| navigationBarColor | #1e1e1e |
| mipmap icons | wzxClaw icons (not Capacitor defaults) |
| splash.png | Dark background (#1e1e1e) |
| strings.xml app_name | wzxClaw |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Gradle 8.11.1 download timeout**
- **Found during:** Task 2
- **Issue:** `gradle-8.11.1-all.zip` download from services.gradle.org consistently timed out (10s network timeout)
- **Fix:** Switched `gradle-wrapper.properties` to use Gradle 8.14 (already cached from Flutter builds)
- **Files modified:** mobile/android/gradle/wrapper/gradle-wrapper.properties
- **Commit:** f04dc28

**2. [Rule 3 - Blocking] Capacitor 7 requires Java 21, dev machine has JDK 17**
- **Found during:** Task 2
- **Issue:** `capacitor-android` module sets `sourceCompatibility JavaVersion.VERSION_21`, compilation fails with JDK 17
- **Fix:** Added `allprojects.subprojects` override in root `build.gradle` to force Java 17 compatibility for all subprojects
- **Files modified:** mobile/android/build.gradle
- **Commit:** f04dc28

**3. [Rule 3 - Blocking] APK filename is app-release-unsigned.apk, not app-release.apk**
- **Found during:** Task 2
- **Issue:** Without signing configuration, Gradle outputs `app-release-unsigned.apk` instead of `app-release.apk`
- **Fix:** Updated build.js to check both filenames and report the actual one found
- **Files modified:** mobile/scripts/build.js
- **Commit:** f04dc28

## Key Architecture Notes

### Build Pipeline (Verified End-to-End)
```
npm run build:apk (in mobile/)
  -> Step 0: JDK auto-detect (JAVA_HOME or known fallback path)
  -> Step 1: cd ../packages/web-ui && npm run build  (Vite SPA -> 700KB)
  -> Step 2: npx cap sync android                     (copy dist/ to assets)
  -> Step 3: cd android && gradlew.bat assembleRelease (269 Gradle tasks)
  -> Output: android/app/build/outputs/apk/release/app-release-unsigned.apk (3.26 MB)
```

### Android Branding
- Icons: Reused from Flutter wzxClaw_android project (same visual identity)
- Splash: Solid dark (#1e1e1e) minimal PNG, Android scales it
- System bars: Both status bar and navigation bar set to #1e1e1e
- Adaptive icons (API 26+): Dark background with wzxClaw icon foreground

### Gradle Compatibility Layer
- Capacitor 7 targets Java 21 but dev environment is JDK 17
- `allprojects.subprojects.afterEvaluate` override forces `JavaVersion.VERSION_17`
- This works because Capacitor core does not actually use Java 21 language features
- When upgrading to JDK 21 in the future, this override can be removed

## Known Stubs

None -- all resources are production-ready.

## Threat Flags

None -- no new network endpoints, auth paths, or security-relevant surface introduced.

## Self-Check: PASSED

- FOUND: mobile/android/app/src/main/res/mipmap-hdpi/ic_launcher.png
- FOUND: mobile/android/app/src/main/res/drawable/splash.png
- FOUND: mobile/android/app/build.gradle (applicationId: com.wzxclaw.mobile)
- FOUND: mobile/scripts/build.js
- FOUND: mobile/android/app/build/outputs/apk/release/app-release-unsigned.apk (3.26 MB)
- FOUND: 9850ca7 (git log)
- FOUND: f04dc28 (git log)
