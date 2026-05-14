---
phase: 04-shared-web-ui
plan: 05
subsystem: web-ui
tags: [assembly, provider, i18n, global-css, integration-tests]
dependency_graph:
  requires: [04a, 04b, 04c, 04d]
  provides: [complete-spa]
  affects: [packages/web-ui]
tech_stack:
  added: [React Context, Zustand i18n store, CSS custom properties]
  patterns: [Context Provider, i18n key-value, CSS variables theme]
key_files:
  created:
    - packages/web-ui/src/providers/DataSourceProvider.tsx
    - packages/web-ui/src/i18n/i18n-store.ts
    - packages/web-ui/src/i18n/locales/zh-CN.ts
    - packages/web-ui/src/i18n/locales/en-US.ts
    - packages/web-ui/src/i18n/useT.ts
    - packages/web-ui/src/i18n/formatRelativeTime.ts
    - packages/web-ui/src/stores/settings-store.ts
    - packages/web-ui/src/styles/global.css
    - packages/web-ui/src/styles/variables.css
    - packages/web-ui/src/__tests__/integration.test.ts
  modified:
    - packages/web-ui/src/App.tsx
    - packages/web-ui/src/styles/chat.css
    - packages/web-ui/src/styles/settings.css
    - packages/web-ui/vite.config.ts
decisions:
  - DataSourceProvider uses React Context (not Zustand) for DataSource injection since DataSource is stateful with connect/disconnect lifecycle
  - CSS variables centralized in variables.css, deduplicated from chat.css and settings.css
  - i18n uses flat key-value (not nested objects) with dot notation for grouping
  - Build uses manualChunks for vendor splitting (react, zustand, markdown, highlight)
metrics:
  duration: 15m
  completed: "2026-05-14"
  tasks: 2
  files_created: 10
  files_modified: 4
  tests_added: 6
  tests_total: 25
---

# Phase 4 Plan 5: Assembly + i18n + Integration Tests Summary

DataSourceProvider + i18n system + global CSS variables + App assembly + integration tests

## Changes Made

### Task 1: DataSourceProvider + i18n system + global CSS + App assembly

**DataSourceProvider** (`src/providers/DataSourceProvider.tsx`):
- React Context provider that creates and manages a DataSource instance
- Auto-detects environment (Electron IPC vs WebSocket) via `createDataSource()`
- Provides `useDataSource()`, `useConnectionState()`, `useReconnect()` hooks
- Lifecycle: mount -> create + connect, unmount -> disconnect
- Config change: `reconnect(newUrl, token)` tears down old DS and creates new one

**i18n system** (`src/i18n/`):
- `i18n-store.ts`: Zustand store with `t(key, params?)` translation function
- Supports `{{param}}` interpolation (e.g., `t('common.minutesAgo', { count: 5 })`)
- Fallback chain: current locale -> zh-CN -> raw key
- `locales/zh-CN.ts`: 80+ Chinese translation keys
- `locales/en-US.ts`: 80+ English translation keys
- `useT.ts`: React hook subscribing to locale changes for re-render
- `formatRelativeTime.ts`: i18n-aware relative time formatting
- Locale persisted to localStorage, auto-detected from browser language

**Global CSS** (`src/styles/`):
- `variables.css`: Centralized CSS custom properties for dark/light themes
  - Background, text, border, accent, spacing, radius, font, shadow, transition variables
  - `[data-theme="light"]` override block for light mode
  - Moved from chat.css `:root` block to avoid duplication
- `global.css`: Reset + body + scrollbar styles + utility classes
  - Imports variables.css first
  - Webkit and Firefox scrollbar customization
  - Consistent font-family, antialiasing, overflow settings

**App.tsx rewrite**:
- DataSourceProvider wraps entire app
- Top navbar: hamburger toggle + logo + connection status indicator (green/red dot) + settings gear
- Main area: collapsible SessionList sidebar + ChatPanel
- SettingsPage as overlay (replaces chat view when active)
- i18n initialized from localStorage/browser language on mount
- Store created per-DataSource instance (recreates on reconnect)

### Task 2: End-to-end integration tests + build config

**Integration tests** (`src/__tests__/integration.test.ts`):
1. Full message flow: createSession -> sendMessage -> stream:text -> stream:done
2. Session CRUD: createSession -> listSessions -> deleteSession
3. Disconnect/reconnect: ws.close() -> onConnectionChange(false) -> reconnect -> onConnectionChange(true)
4. Settings persistence: different URLs create different DataSource instances
5. Multi-event stream: thinking + text + tool_call + tool_result + done sequence
6. i18n: t() translation with param interpolation, locale switching, fallback

**vite.config.ts**:
- `base: './'` for deploy-anywhere static hosting
- `manualChunks`: vendor-react, vendor-zustand, vendor-markdown, vendor-highlight
- Build produces dist/ with properly separated chunks

## Test Results

- **25 tests pass** (19 existing + 6 new integration tests)
- `npm run typecheck` passes (0 errors)
- `npm run build` succeeds (dist/ with index.html + 6 assets)
- `npm test` passes in ~800ms

## Deviations from Plan

None -- plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

- All 10 created files verified present
- Both commits verified in git log (cb599e8, a25ea91)
- `npm run typecheck` clean
- `npm test` 25/25 pass
- `npm run build` produces deployable dist/
