---
phase: 03-ide-shell
plan: 02
subsystem: renderer-ui
tags: [react, monaco-editor, zustand, allotment, file-explorer, tab-bar, vs-dark]

requires:
  - phase: 03-ide-shell
    provides: WorkspaceManager IPC handlers, preload bridge, FileTreeNode/EditorTab types
provides:
  - Zustand workspace-store with openFolder, loadTree, expandNode, collapseNode, handleFileChange
  - Zustand tab-store with openTab, closeTab, setActiveTab, updateTabContent, saveTab, refreshTabContent
  - IDELayout with allotment resizable sidebar + editor area + status bar
  - FileExplorer recursive directory tree with lazy-loaded children and context menu
  - TabBar with horizontal scrollable tabs, dirty indicators, close buttons
  - EditorPanel with Monaco Editor vs-dark theme, Ctrl+S save, automatic layout
  - Sidebar with Open Folder button and FileExplorer integration
  - StatusBar showing active file path, encoding, agent status
  - WelcomeScreen with branding and keyboard shortcut hints
  - VS Code Dark+ CSS theme with full IDE styling
affects: [03-ide-shell, chat-panel, agent-integration]

tech-stack:
  added: [@monaco-editor/react, monaco-editor, allotment]
  patterns: [zustand-store-for-ui-state, allotment-resizable-layout, monaco-controlled-editor, recursive-tree-component]

key-files:
  created:
    - src/renderer/stores/workspace-store.ts
    - src/renderer/stores/tab-store.ts
    - src/renderer/components/ide/IDELayout.tsx
    - src/renderer/components/ide/Sidebar.tsx
    - src/renderer/components/ide/FileExplorer.tsx
    - src/renderer/components/ide/TabBar.tsx
    - src/renderer/components/ide/EditorPanel.tsx
    - src/renderer/components/ide/StatusBar.tsx
    - src/renderer/components/ide/WelcomeScreen.tsx
    - src/renderer/styles/ide.css
  modified:
    - src/renderer/App.tsx
    - src/renderer/main.tsx
    - src/renderer/index.html

key-decisions:
  - "Allotment chosen over react-split-pane for resizable panels — simpler API, better maintained"
  - "React.StrictMode removed from main.tsx — Monaco Editor does not handle double-mount well"
  - "react-window deferred — not needed for MVP file explorer, optimize later with performance data"
  - "Monaco Editor uses controlled mode (value prop) to sync with Zustand tab state"
  - "Context menu implemented as positioned div (no library) for MVP simplicity"
  - "Rename/Delete in context menu are stubs (console.log) — deferred to later phase"

patterns-established:
  - "Store pattern: Zustand stores consumed directly by components via selectors (no props drilling)"
  - "Tab pattern: openTab checks for existing tab by filePath before creating new one"
  - "Editor pattern: Monaco Editor path prop keyed by filePath for proper model switching"

requirements-completed: [EDIT-01, EDIT-02, EDIT-03]

duration: 11min
completed: 2026-04-03
---

# Phase 3 Plan 2: Renderer IDE Layout Summary

**VS Code-style IDE layout with resizable sidebar, recursive FileExplorer, multi-tab TabBar, and Monaco Editor with vs-dark theme**

## Performance

- **Duration:** 11 min
- **Started:** 2026-04-03T12:04:34Z
- **Completed:** 2026-04-03T12:15:47Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments
- Zustand workspace-store with full workspace lifecycle: open folder, load tree, expand/collapse nodes, handle file changes
- Zustand tab-store with complete tab management: open/close tabs, active tab tracking, dirty state, save to disk, content refresh
- IDELayout using allotment for resizable split between sidebar (150-500px) and editor area
- FileExplorer with recursive directory tree, lazy-loaded children on expand, unicode icons, right-click context menu
- TabBar with horizontal scrollable tabs, dirty indicator dot, close button, middle-click to close, active tab highlighting
- EditorPanel with Monaco Editor in vs-dark theme, Ctrl+S save binding, automatic layout, word wrap, tab size 2
- StatusBar showing active file path, UTF-8 encoding, and "Ready" agent status placeholder
- WelcomeScreen with wzxClaw branding and keyboard shortcut hints
- VS Code Dark+ CSS theme with 15+ color variables and full component styling

## Task Commits

Each task was committed atomically:

1. **Task 1: Install UI dependencies, create Zustand stores, and build IDE layout components** - `15c327f` (feat)
2. **Task 2: Build FileExplorer, TabBar, and EditorPanel components** - `828d4c5` (feat)

## Files Created/Modified
- `src/renderer/stores/workspace-store.ts` - Zustand store for workspace root, directory tree, expand/collapse, file change handling
- `src/renderer/stores/tab-store.ts` - Zustand store for editor tabs, active tab, dirty tracking, save to disk via IPC
- `src/renderer/components/ide/IDELayout.tsx` - Root layout with allotment resizable split, keyboard shortcuts (Ctrl+S, Ctrl+Shift+O), file change subscription
- `src/renderer/components/ide/Sidebar.tsx` - File explorer panel with Open Folder button, workspace name, FileExplorer integration
- `src/renderer/components/ide/FileExplorer.tsx` - Recursive directory tree with lazy loading, unicode icons, context menu
- `src/renderer/components/ide/TabBar.tsx` - Horizontal scrollable tabs with file names, dirty indicator, close button
- `src/renderer/components/ide/EditorPanel.tsx` - Monaco Editor wrapper with vs-dark theme, controlled content, Ctrl+S save
- `src/renderer/components/ide/StatusBar.tsx` - Bottom bar with file path, encoding, agent status
- `src/renderer/components/ide/WelcomeScreen.tsx` - Empty state with branding and shortcuts
- `src/renderer/styles/ide.css` - VS Code Dark+ theme with CSS variables, component styles, scrollbar styling
- `src/renderer/App.tsx` - Updated to render IDELayout instead of Phase 1 placeholder
- `src/renderer/main.tsx` - Removed StrictMode (Monaco double-mount issue)
- `src/renderer/index.html` - Added full-viewport reset styles

## Decisions Made
- Allotment chosen over react-split-pane for resizable panels: simpler API, actively maintained, zero config
- React.StrictMode removed from main.tsx: Monaco Editor creates duplicate instances on double-mount, causing visual artifacts
- react-window deferred: file explorer tree performance optimization deferred until we have real-world data on large projects
- Monaco Editor uses controlled mode (value prop + onChange): ensures Zustand tab state is single source of truth
- Context menu as positioned div: no external library needed for 3-item menu in MVP
- Rename/Delete in context menu are stubs: these require IPC channels not yet defined, deferred to future phase

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - all dependencies installed via npm.

## Next Phase Readiness
- IDE shell complete with Monaco Editor, file explorer, tab management
- Ready for Plan 03-03: Agent integration (Ctrl+S save wired, dirty tracking working, auto-refresh for agent edits)
- Chat Panel (Phase 4) can be added as a third allotment pane or overlay

---
*Phase: 03-ide-shell*
*Completed: 2026-04-03*

## Self-Check: PASSED

- All 13 files verified present on disk
- Both task commits verified in git log (15c327f, 828d4c5)
- TypeScript compilation: zero errors
- All 156 tests passing (17 test files)
- electron-vite build: successful (main 54KB, preload 2KB, renderer 650KB)
