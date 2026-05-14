---
phase: "04"
plan: "01"
subsystem: "web-ui"
tags: ["scaffolding", "data-source", "websocket", "ipc", "abstraction"]
dependency_graph:
  requires: []
  provides: ["packages/web-ui", "DataSource interface", "WebSocketDataSource", "IpcDataSource"]
  affects: []
tech_stack:
  added:
    - "Vite 6.4.2"
    - "React 19"
    - "Zustand 5"
    - "TypeScript 5.7"
    - "vitest 3"
  patterns:
    - "DataSource abstraction interface with two implementations"
    - "Store factory pattern (inject DataSource for testability)"
    - "WebSocket exponential backoff reconnection"
    - "IPC-to-DataSource bridge mapping"
key_files:
  created:
    - "packages/web-ui/package.json"
    - "packages/web-ui/tsconfig.json"
    - "packages/web-ui/tsconfig.node.json"
    - "packages/web-ui/vite.config.ts"
    - "packages/web-ui/index.html"
    - "packages/web-ui/src/main.tsx"
    - "packages/web-ui/src/App.tsx"
    - "packages/web-ui/src/vite-env.d.ts"
    - "packages/web-ui/src/data-source/types.ts"
    - "packages/web-ui/src/data-source/websocket-source.ts"
    - "packages/web-ui/src/data-source/ipc-source.ts"
    - "packages/web-ui/src/data-source/index.ts"
    - "packages/web-ui/src/data-source/__tests__/websocket-source.test.ts"
    - "packages/web-ui/src/data-source/__tests__/ipc-source.test.ts"
  modified: []
decisions:
  - "DataSource interface with 15+ methods covers all UI-backend communication needs"
  - "WebSocketDataSource uses request-response pattern (pending request map) for session CRUD"
  - "IpcDataSource maps stream events from IPC channel names to unified StreamEventType"
  - "createDataSource() factory auto-detects environment for zero-config usage"
  - "URL protocol validation (ws/wss only) for WebSocket security (T-04-01)"
metrics:
  duration_minutes: 12
  completed: "2026-05-14"
  tasks_completed: 2
  tests_passed: 9
  files_created: 14
---

# Phase 04 Plan 01: Web-UI Package Scaffolding + DataSource Abstraction Summary

One-liner: Created `packages/web-ui/` with Vite + React 19 + TypeScript, defining a DataSource interface with WebSocketDataSource (remote agent-server) and IpcDataSource (Electron preload bridge) implementations and 9 passing tests.

## What Was Done

### Task 1: Package scaffolding + DataSource interface + WebSocketDataSource

Created complete `packages/web-ui/` package:

- **Vite + React 19 + TypeScript + Zustand 5** scaffolding with dev server on port 5173
- **DataSource interface** (`types.ts`) with 15+ methods covering connection lifecycle, agent operations, stream events, session CRUD, and settings
- **StreamEventType** union type with 9 event types and typed payloads (TextStreamPayload, ToolCallStreamPayload, etc.)
- **WebSocketDataSource** connecting to agent-server Client protocol with:
  - URL protocol validation (only ws/wss allowed, mitigates T-04-01)
  - Event subscription via `_listeners` Map with per-type callback sets
  - Request-response pattern for session CRUD (pending request map with timeout)
  - Exponential backoff reconnection (1s -> 2s -> 4s -> 8s -> 16s -> 30s cap)
  - Automatic cleanup of pending requests on disconnect

5 tests passing: connect+onConnectionChange, send/receive, reconnection, session:list, interface compliance.

### Task 2: IpcDataSource + DataSource factory + barrel export

- **IpcDataSource** wrapping `window.wzxclaw` preload API:
  - Maps all stream events (text, thinking, tool_call, tool_result, done, error, turn_end, compacted) to unified StreamEventType
  - Translates DataSource method signatures to IPC request formats (e.g., sessionId -> { sessionId })
  - Safe `typeof window` checks for Node.js test environments
  - Unsubscribe tracking for cleanup on disconnect()
- **createDataSource()** factory function auto-detecting environment
- **Barrel export** at `data-source/index.ts` with all types, classes, and factory

4 tests passing: sendMessage delegation, onStreamEvent('text') mapping, listSessions, unavailable rejection.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed unused _reconnectDelay field in WebSocketDataSource**
- **Found during:** Task 1 typecheck
- **Issue:** TypeScript strict mode flagged unused private field
- **Fix:** Removed the field, kept BACKOFF_STEPS array as the single source of delay values
- **Files modified:** `websocket-source.ts`
- **Commit:** 534e640

**2. [Rule 3 - Blocking] Node.js test environment has no `window` global**
- **Found during:** Task 2 first test run
- **Issue:** IpcDataSource uses `window.wzxclaw` but vitest runs in Node.js where `window` is undefined
- **Fix:** Test sets `globalThis.window = globalThis` in beforeEach; IpcDataSource constructor already used `typeof window !== 'undefined'` guard
- **Files modified:** `ipc-source.test.ts`
- **Commit:** def4574

## Verification Results

| Check | Result |
|-------|--------|
| `npm install` | 106 packages installed |
| `npm test` | 9/9 tests passing |
| `npm run typecheck` | 0 errors |
| `npm run dev` | Vite dev server on :5173 |
| `npx vite build` | Production build in 835ms (195KB) |

## Commits

| Commit | Message |
|--------|---------|
| 534e640 | feat(04-01): scaffold web-ui package + DataSource interface + WebSocketDataSource |
| def4574 | feat(04-01): add IpcDataSource + DataSource factory + barrel export |

## Self-Check: PASSED

All 14 files verified present. Both commits (534e640, def4574) found in git log.
