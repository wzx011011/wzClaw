---
phase: 05-desktop-electron
plan: 01
subsystem: desktop-shell
tags: [electron-vite, renderer-migration, ipc, preload, web-ui]
dependency_graph:
  requires: [packages/web-ui]
  provides: [electron-shell-web-ui]
  affects: [wzxClaw_desktop/electron.vite.config.ts, wzxClaw_desktop/src/preload/index.ts, wzxClaw_desktop/src/main/ipc-handlers/session-ipc-handlers.ts]
tech_stack:
  added: [electron-vite renderer root override]
  patterns: [renderer-as-external-package, preload-bridge-ipc]
key_files:
  created: []
  modified:
    - wzxClaw_desktop/electron.vite.config.ts
    - wzxClaw_desktop/src/shared/ipc-channels.ts
    - wzxClaw_desktop/src/preload/index.ts
    - wzxClaw_desktop/src/main/ipc-handlers/session-ipc-handlers.ts
decisions:
  - D-01: Used electron-vite renderer.root to point to packages/web-ui instead of symlink or copy
  - D-02: Added session:create IPC channel (new) rather than reusing session:ensure
  - D-03: Did not modify web-ui IpcDataSource (chat-store fallback handles createSession throw)
metrics:
  duration: 14m
  completed: "2026-05-14"
  tasks_completed: 3
  files_modified: 4
  tests_passing: 66/66 files, 753/753 tests
---

# Phase 5 Plan 01: Electron Renderer Migration Summary

Replaced Electron renderer source from legacy src/renderer/ to shared packages/web-ui/ SPA, enabling unified UI across desktop and mobile platforms.

## Tasks Completed

| Task | Name | Commit | Files Modified |
|------|------|--------|----------------|
| 1 | electron-vite config for web-ui | 8a26b94 | electron.vite.config.ts |
| 2 | createSession IPC + preload | 60ca6a3 | ipc-channels.ts, preload/index.ts, session-ipc-handlers.ts |
| 3 | Integration verification | (no changes needed) | - |

## Key Changes

### Task 1: electron-vite config
- Set `renderer.root` to `packages/web-ui/` (resolved from `wzxClaw_desktop/`)
- Added `@` alias mapping to `packages/web-ui/src/`
- Configured `rollupOptions.input` to explicitly use `packages/web-ui/index.html`
- Added `manualChunks` for react, zustand, markdown, and highlight.js vendor splitting
- Set `__VITE_AGENT_URL__` define for web-ui compatibility
- Build output remains at `out/renderer/` with `base: './'`

### Task 2: session:create IPC
- Added `session:create` channel to `IPC_CHANNELS` with request/response types and Zod schemas
- Added `createSession` method to preload API: `ipcRenderer.invoke('session:create', request)`
- Added `session:create` handler in `session-ipc-handlers.ts`:
  - Generates UUID via `crypto.randomUUID()`
  - Creates empty JSONL file with meta line (title: 'Untitled')
  - Fires `dataChanged` notification for mobile sync
  - Returns `{ sessionId }`

### Task 3: Verification
- `electron-vite build` succeeds, renderer output contains web-ui assets (386 modules)
- All 66 test files pass (753 tests, 5 skipped)
- `mainWindow.loadURL`/`mainWindow.loadFile` paths work correctly without changes
- Dev mode: `ELECTRON_RENDERER_URL` auto-set by electron-vite dev server from web-ui root
- Production mode: `out/renderer/index.html` loads from build output

## Decisions Made

1. **Renderer root override** - Used `renderer.root` config in electron-vite to point to `packages/web-ui/`. This is cleaner than symlinks or copies, and electron-vite 3.x supports this natively.

2. **New session:create channel** - Added a dedicated `session:create` IPC channel rather than reusing `session:ensure`. The `ensure` endpoint requires a client-generated sessionId, while `create` generates one server-side, which is the pattern IpcDataSource expects.

3. **Did not modify web-ui** - Per plan constraints, `packages/web-ui/` was not modified. The `IpcDataSource.createSession()` still throws, but the chat-store catches it and uses a client-generated UUID fallback. A future task can update IpcDataSource to use `window.wzxclaw.createSession()`.

## Deviations from Plan

None - plan executed exactly as written.

## Deferred Items

- IpcDataSource still throws in createSession() - chat-store fallback handles it. Future task should update IpcDataSource to call `window.wzxclaw.createSession()` now that it exists.
- Splash drag region in old renderer `index.html` is not present in web-ui. This means a brief moment where the Electron titlebar drag region is not active before React mounts. Acceptable for now.

## Self-Check: PASSED

- electron.vite.config.ts: FOUND
- preload/index.ts: FOUND (createSession method present)
- session-ipc-handlers.ts: FOUND (session:create handler present)
- ipc-channels.ts: FOUND (session:create channel defined)
- SUMMARY.md: FOUND
- Commit 8a26b94 (Task 1): FOUND
- Commit 60ca6a3 (Task 2): FOUND
