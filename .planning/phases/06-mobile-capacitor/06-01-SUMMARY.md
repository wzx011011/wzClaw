---
phase: 06-mobile-capacitor
plan: 01
subsystem: mobile
tags: [capacitor, android, mobile-responsive, web-ui]
dependency_graph:
  requires: [packages/web-ui/]
  provides: [mobile/, mobile-responsive-css]
  affects: [packages/web-ui/src/App.tsx, packages/web-ui/src/styles/]
tech_stack:
  added: [capacitor-7, @capacitor/android, @capacitor/keyboard, @capacitor/preferences, @capacitor/splash-screen, @capacitor/status-bar]
  patterns: [capacitor-webview-shell, css-media-queries, mobile-sidebar-overlay]
key_files:
  created:
    - mobile/package.json
    - mobile/capacitor.config.ts
    - mobile/scripts/build.js
    - mobile/resources/README.md
    - mobile/android/ (58 files auto-generated)
    - packages/web-ui/src/styles/mobile.css
  modified:
    - packages/web-ui/src/styles/global.css
    - packages/web-ui/src/App.tsx
decisions:
  - D-01: Used Capacitor 7 (latest stable) to wrap web-ui SPA as native Android app
  - D-02: webDir set to ../packages/web-ui/dist (relative path from mobile/ to web-ui build output)
  - D-03: Mobile sidebar uses fixed overlay pattern (not inline) to avoid layout shift
  - D-04: Added typescript as devDependency for capacitor.config.ts parsing
  - D-05: Android Manifest customized with cleartext traffic, singleTop, adjustResize
metrics:
  duration: 19m
  completed: 2026-05-14
  tasks: 2
  files: 63
---

# Phase 6 Plan 01: Capacitor Shell + Mobile Responsive CSS Summary

Capacitor 7 project wrapping web-ui SPA for Android, with responsive CSS media queries and mobile sidebar overlay pattern.

## Tasks Completed

### Task 1: Capacitor Project Scaffold + Android Platform Init

Created `mobile/` Capacitor project with full Android platform. The project wraps the web-ui SPA at `packages/web-ui/dist/` using Capacitor's webDir mechanism. Android project auto-generated via `npx cap add android` with 4 native plugins (keyboard, preferences, splash-screen, status-bar). AndroidManifest.xml customized for cleartext WebSocket traffic, singleTop launch mode, and adjustResize keyboard behavior. Build script chains web-ui build, Capacitor sync, and Gradle assembleRelease.

**Commit:** f75b65c

### Task 2: Web-UI Mobile Responsive CSS + Layout Adaptation

Added `mobile.css` with responsive breakpoints at 768px. Key adaptations: sidebar hidden by default on mobile (CSS `display: none`), larger touch targets (36px buttons), 16px input font to prevent iOS auto-zoom, safe-area-inset support for Capacitor fullscreen. App.tsx modified with `isMobileViewport()` detection, default collapsed sidebar on mobile, resize listener, and overlay-based sidebar rendering (fixed position with backdrop animation) for mobile viewports vs inline rendering for desktop.

**Commit:** 389b928

## Verification Results

| Check | Result |
|-------|--------|
| `npm install` in mobile/ | PASS |
| `npm run build` in packages/web-ui | PASS (no warnings) |
| `npm test` in packages/web-ui | PASS (25/25 tests) |
| `npx cap sync android` in mobile/ | PASS |
| mobile.css `@media` count | 2 media query blocks |
| global.css imports mobile.css | PASS |
| App.tsx contains isMobile | PASS (6 occurrences) |
| capacitor config webDir | PASS (../packages/web-ui/dist) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] TypeScript dependency for capacitor.config.ts**
- **Found during:** Task 1
- **Issue:** `npx cap add android` failed with "Could not find installation of TypeScript"
- **Fix:** Added `typescript` as devDependency in mobile/package.json
- **Files modified:** mobile/package.json
- **Commit:** f75b65c

**2. [Rule 1 - Bug] PostCSS @import ordering warning**
- **Found during:** Task 2
- **Issue:** `@import './mobile.css'` at end of global.css triggered PostCSS warning: "@import must precede all other statements"
- **Fix:** Moved the @import to top of global.css (after variables.css import)
- **Files modified:** packages/web-ui/src/styles/global.css
- **Commit:** 389b928

## Key Architecture Notes

### Build Pipeline
```
npm run build:apk (in mobile/)
  -> Step 1: cd ../packages/web-ui && npm run build  (Vite SPA build)
  -> Step 2: npx cap sync android                     (copy dist/ to android assets)
  -> Step 3: cd android && ./gradlew assembleRelease  (APK packaging)
  -> Output: mobile/android/app/build/outputs/apk/release/app-release.apk
```

### Mobile Layout Pattern
- Desktop (>768px): inline sidebar + chat panel (original layout)
- Mobile (<=768px): sidebar hidden, hamburger opens fixed overlay with slide-in animation
- CSS handles visibility (`display: none` on `.session-list` in mobile breakpoint)
- JS handles overlay mode (conditional rendering based on `isMobileViewport()`)

### Android Customization
- `android:usesCleartextTraffic="true"` -- allows `ws://` during development
- `android:launchMode="singleTop"` -- prevents duplicate activities
- `android:windowSoftInputMode="adjustResize"` -- keyboard pushes content up
- `android:hardwareAccelerated="true"` -- GPU-accelerated WebView
- Dark theme colors: `#1e1e1e` background, `#4a9eff` accent

## Manual Steps Required

### Building APK
The `npm run build:apk` command in `mobile/` requires:
1. **JDK 17** -- set `JAVA_HOME` environment variable
2. **Android SDK** -- with `ANDROID_HOME` pointing to SDK installation
3. Run: `cd mobile && npm run build:apk`

### Future: Custom Icons
Replace default Capacitor icons:
1. Place `icon.png` (1024x1024) and `splash.png` (2732x2732) in `mobile/resources/`
2. Run: `npx @capacitor/assets generate`
3. Run: `npx cap sync android`

## Self-Check: PASSED

- FOUND: mobile/package.json
- FOUND: mobile/capacitor.config.ts
- FOUND: mobile/scripts/build.js
- FOUND: mobile/android/ (directory)
- FOUND: packages/web-ui/src/styles/mobile.css
- FOUND: f75b65c (git log)
- FOUND: 389b928 (git log)
