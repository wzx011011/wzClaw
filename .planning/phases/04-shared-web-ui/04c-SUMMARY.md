---
phase: 04-shared-web-ui
plan: 03
subsystem: web-ui
tags: [session-management, settings, connection-config, localStorage, TDD]
dependency_graph:
  requires: [04a, 04b]
  provides: [session-list-ui, settings-page, connection-config-hook, session-crud-store]
  affects: [chat-store, App-shell]
tech_stack:
  added: []
  patterns: [useConnectionConfig-hook, factory-pattern-store, prop-injection]
key_files:
  created:
    - packages/web-ui/src/stores/__tests__/chat-store-session.test.ts
    - packages/web-ui/src/components/chat/SessionList.tsx
    - packages/web-ui/src/components/ui/ContextMenu.tsx
    - packages/web-ui/src/components/settings/SettingsPage.tsx
    - packages/web-ui/src/styles/settings.css
    - packages/web-ui/src/hooks/useConnectionConfig.ts
  modified:
    - packages/web-ui/src/stores/chat-store.ts
    - packages/web-ui/src/styles/chat.css
    - packages/web-ui/src/App.tsx
decisions:
  - "SessionList receives store via props (same pattern as ChatPanel) instead of global useChatStore hook"
  - "Session caching uses module-level Map for switchSession performance"
  - "Settings config persisted to localStorage under wzxclaw-connection-config key"
  - "URL validation restricts to ws:// and wss:// protocols only (T-04-06)"
metrics:
  duration: 593s
  completed: 2026-05-14
  tasks: 2
  tests_added: 4
  tests_total: 19
  files_created: 6
  files_modified: 3
---

# Phase 4 Plan 03: Session Management + Settings Summary

Session management UI with CRUD operations and agent-server connection settings page with localStorage persistence, built via TDD (RED/GREEN cycle).

## What Was Done

### Task 1: chat-store session operations + SessionList component (TDD)

**TDD Cycle:**
- RED: 4 failing tests for loadSessionList, switchSession, deleteSession, renameSession
- GREEN: All 4 tests pass after implementing session methods in chat-store.ts

**chat-store.ts additions:**
- `sessions: SessionMeta[]` and `activeSessionId: string | null` state fields
- `loadSessionList()`: fetches sessions from DataSource, updates state
- `loadSession(sid)`: loads raw messages, converts via `buildChatMessagesFromRaw()`, updates messages + conversationId
- `switchSession(sid)`: caches current session in module-level Map, loads target from cache or DataSource
- `deleteSession(sid)`: calls DataSource, filters sessions array, clears conversation if deleting active session
- `renameSession(sid, title)`: calls DataSource, updates title in sessions array
- `buildChatMessagesFromRaw()` helper converts RawMessage[] to ChatMessage[]

**New components:**
- `ContextMenu.tsx`: generic right-click menu (separator, danger, shortcut, disabled support), auto-position adjustment
- `SessionList.tsx`: session list with search, time grouping (today/yesterday/earlier), right-click rename/delete, double-click rename, delete confirmation with 5s auto-dismiss

### Task 2: Settings page + connection configuration

**useConnectionConfig.ts hook:**
- Manages agentUrl, token, language, themeMode in localStorage
- URL validation: only `ws://` and `wss://` protocols allowed (mitigates T-04-06)
- Theme application via `data-theme` attribute on document root
- Default values: ws://localhost:8082, empty token, zh-CN, dark mode

**SettingsPage.tsx:**
- Connection config section: agent URL input + token input (password) + test connection button
- Test connection creates temporary DataSource, attempts connect/disconnect, shows success/failure
- Appearance section: theme radio (dark/light) + language select (zh-CN/en)
- Save button writes to localStorage

**App.tsx updates:**
- Left sidebar: SessionList + new-session button + settings gear icon
- Right panel: ChatPanel
- Simple view state toggle between chat and settings (no router needed)
- Light theme CSS variables via `[data-theme="light"]` selector

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

- TypeScript type check: pass (zero errors)
- Tests: 19/19 pass (4 session + 6 chat-store + 5 websocket-source + 4 ipc-source)

## Threat Model Compliance

| Threat ID | Mitigation | Status |
|-----------|-----------|--------|
| T-04-06 | URL validation in useConnectionConfig — only ws:// and wss:// allowed | Implemented |
| T-04-07 | Token in localStorage — accepted (same trust level as Electron) | Accepted |

## Commits

| Commit | Message |
|--------|---------|
| 0d5c751 | test(04-03): add failing session CRUD tests for chat-store |
| ea7d708 | feat(04-03): add session CRUD operations + SessionList component |
| 4395973 | feat(04-03): add Settings page + connection config + App layout with SessionList |

## Self-Check: PASSED

All 8 created/modified files verified present on disk. All 3 commits verified in git log.
