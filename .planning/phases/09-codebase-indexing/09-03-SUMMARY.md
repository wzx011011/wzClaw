---
phase: 09-codebase-indexing
plan: 03
subsystem: indexing
tags: [index-store, status-bar, command-palette, preload-bridge, ipc]

# Dependency graph
requires:
  - phase: 09-codebase-indexing
    provides: "IPC channels (index:status, index:reindex, index:search, index:progress) from Plan 02"
provides:
  - "IndexStore (renderer-side indexing state tracking)"
  - "StatusBar index status indicator (indexing/ready/error)"
  - "Re-index Workspace command in command palette"
  - "Preload bridge for index IPC channels"
affects:
  - phase: 09-codebase-indexing
    description: "Completes the indexing feature: users can see progress and trigger re-index"

# Key files
created:
  - src/renderer/stores/index-store.ts
  - src/renderer/stores/__tests__/index-store.test.ts
modified:
  - src/preload/index.ts
  - src/renderer/env.d.ts
  - src/renderer/components/ide/StatusBar.tsx
  - src/renderer/stores/command-store.ts
  - src/renderer/components/ide/IDELayout.tsx
  - src/renderer/stores/__tests__/command-store.test.ts

# Key decisions
key-decisions:
  - "D-IDX-09: IndexStore follows chat-store pattern -- init() returns unsubscribe, subscribe to IPC progress events"
  - "D-IDX-10: Status bar uses simple ASCII text for index status (no codicon dependency) -- ~ Indexing... (N), N indexed, ! Index Error"
  - "D-IDX-11: Re-index Workspace command added to Index category in command palette, wired via store.getState().reindex()"

# Metrics
duration_seconds: 325
completed_date: "2026-04-08"
tasks_completed: 2
files_created: 2
files_modified: 5
tests_added: 9
---

# Phase 9 Plan 03: Renderer Index UI Summary

Zustand IndexStore for tracking codebase indexing status with real-time IPC progress events, status bar integration showing indexing state, and a Re-index Workspace command in the command palette.

## What was done

### Task 1: Create IndexStore and update preload bridge

Created `src/renderer/stores/index-store.ts` -- a Zustand store tracking `status` (idle/indexing/ready/error), `fileCount`, `currentFile`, and `error`. The store provides:
- `init()` -- subscribes to `index:progress` IPC events and fetches initial status; returns unsubscribe function
- `reindex()` -- triggers full re-index via `index:reindex` IPC channel
- `getStatus()` -- fetches current index state from main process

Updated `src/preload/index.ts` to expose four new methods: `getIndexStatus`, `reindex`, `searchIndex`, and `onIndexProgress`. Updated TypeScript declarations in `src/renderer/env.d.ts`.

### Task 2: Update StatusBar with index status and add Re-index command

Updated `StatusBar.tsx` to show index status in the right section of the status bar:
- Indexing: `~ Indexing... (N)` with file count
- Ready: `N indexed` with file count
- Error: `! Index Error` in red
- Idle: hidden (no display)

Added `index.reindex` command to the command palette (category: Index). Updated `command-store.ts` deps interface with `reindex` handler. Wired everything in `IDELayout.tsx` with `useIndexStore.getState().init()` subscription and reindex dep.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed command-store test expecting 8 built-in commands (now 9)**
- **Found during:** Task 2
- **Issue:** Existing test asserted `toHaveLength(8)` but adding the reindex command made it 9
- **Fix:** Updated assertion to 9, added reindex to mock deps, added Re-index Workspace to label expectations
- **Files modified:** `src/renderer/stores/__tests__/command-store.test.ts`
- **Commit:** `e131fbc`

**2. [Rule 1 - Bug] Fixed pre-existing toggle-terminal test expecting available: false**
- **Found during:** Task 2
- **Issue:** Test expected `available: false` for toggle-terminal, but Phase 8 changed it to `available: true` when terminal was implemented
- **Fix:** Updated test to expect `available: true` with descriptive test name
- **Files modified:** `src/renderer/stores/__tests__/command-store.test.ts`
- **Commit:** `e131fbc`

## Known Stubs

None. All functionality is wired end-to-end (preload bridge -> IPC channels -> main process handlers created in Plan 02).

## Self-Check: PASSED

- `src/renderer/stores/index-store.ts` -- FOUND
- `src/renderer/stores/__tests__/index-store.test.ts` -- FOUND
- `src/preload/index.ts` -- verified modified (contains index methods)
- `src/renderer/env.d.ts` -- verified modified (contains index types)
- `src/renderer/components/ide/StatusBar.tsx` -- verified modified (contains index status)
- `src/renderer/stores/command-store.ts` -- verified modified (contains reindex command)
- `src/renderer/components/ide/IDELayout.tsx` -- verified modified (contains index init)
- Commit `263dccf` -- FOUND
- Commit `e131fbc` -- FOUND
- All 41 renderer store tests passing
- TypeScript compilation: no errors
