---
phase: 07-core-interaction
plan: 03
subsystem: ui
tags: [react, zustand, monaco, diff, decorations, ipc, inline-preview]

# Dependency graph
requires:
  - phase: 07-core-interaction/07-01
    provides: Multi-session chat-store with Zustand pattern, IPC channel infrastructure
provides:
  - DiffStore with LCS-based hunk computation and per-hunk accept/reject actions
  - DiffPreview component with Accept All / Reject All toolbar
  - Monaco inline diff decorations (red/green line backgrounds, glyph margin indicators)
  - ToolCard Review Changes button for FileWrite/FileEdit tools
  - file:apply-hunk IPC channel for writing accepted hunks to disk
  - DiffHunk and PendingDiff types with add/delete/replace hunk classification
affects: [08-terminal-tools, editor-panel, tool-card]

# Tech tracking
tech-stack:
  added: []
patterns: [LCS-based diff computation, Monaco deltaDecorations for diff rendering, per-hunk accept/reject pattern]

key-files:
  created:
    - src/renderer/stores/diff-store.ts
    - src/renderer/components/chat/DiffPreview.tsx
    - src/renderer/stores/__tests__/diff-store.test.ts
  modified:
    - src/shared/types.ts
    - src/shared/constants.ts
    - src/shared/ipc-channels.ts
    - src/preload/index.ts
    - src/main/ipc-handlers.ts
    - src/renderer/components/ide/EditorPanel.tsx
    - src/renderer/components/chat/ToolCard.tsx
    - src/renderer/components/chat/ChatPanel.tsx
    - src/renderer/styles/chat.css

key-decisions:
  - "D-96: LCS-based diff algorithm computes hunks in-browser without external diff library dependency"
  - "D-97: Monaco deltaDecorations used for inline diff rendering (red/green backgrounds + glyph margin) instead of Monaco DiffEditor"
  - "D-98: Per-hunk accept/reject removes individual hunks; last hunk removal cleans up entire diff automatically"

patterns-established:
  - "DiffStore pattern: addDiff computes hunks lazily, acceptHunk/rejectHunk update store and call IPC, last-hunk edge case auto-cleans"
  - "Monaco decorations: useEffect watches diff store state, calls editor.deltaDecorations() to update line highlights"

requirements-completed: [DIFF-01, DIFF-02, DIFF-03, DIFF-04, DIFF-05, DIFF-06, DIFF-07]

# Metrics
duration: 11min
completed: 2026-04-08
---

# Phase 7 Plan 3: Inline Monaco Diff Preview Summary

**LCS-based inline diff preview with per-hunk accept/reject, Monaco red/green decorations, and IPC-backed disk application for AI file changes**

## Performance

- **Duration:** 11 min
- **Started:** 2026-04-08T04:27:45Z
- **Completed:** 2026-04-08T04:38:49Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Created DiffStore with LCS-based hunk computation that classifies changes as add/delete/replace and supports per-hunk accept/reject actions
- Built DiffPreview component with Accept All / Reject All toolbar, per-hunk Accept/Reject buttons, and diff line rendering
- Integrated Monaco editor diff decorations via deltaDecorations API: red backgrounds for deletions, green for additions, glyph margin indicators, overview ruler colors
- Added Review Changes button to ToolCard for completed FileWrite/FileEdit tool calls
- Added file:apply-hunk IPC channel end-to-end (IPC channels, preload bridge, main handler)
- Full test suite passes: 232/232 tests (11 new diff-store tests)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create DiffStore with hunk management, accept/reject actions** - TDD
   - RED: `b056c15` (test: failing tests for DiffStore hunk management)
   - GREEN: `d35b32f` (feat: DiffStore with hunk computation, accept/reject, apply-hunk IPC)

2. **Task 2: DiffPreview component, Monaco decorations, ToolCard integration, toolbar** - `0fe3f77` (feat)

## Files Created/Modified
- `src/renderer/stores/diff-store.ts` - Zustand store with LCS diff computation and per-hunk accept/reject
- `src/renderer/stores/__tests__/diff-store.test.ts` - 11 unit tests covering all actions and hunk computation
- `src/renderer/components/chat/DiffPreview.tsx` - Diff preview component with toolbar and hunk list
- `src/shared/types.ts` - Added DiffHunk and PendingDiff interfaces
- `src/shared/constants.ts` - Added MAX_DIFF_FILE_LINES and DIFF_CONTEXT_LINES
- `src/shared/ipc-channels.ts` - Added file:apply-hunk channel with request/response types
- `src/preload/index.ts` - Added applyHunk bridge method
- `src/main/ipc-handlers.ts` - Added file:apply-hunk handler for writing accepted content
- `src/renderer/components/ide/EditorPanel.tsx` - Added Monaco diff decorations via deltaDecorations, read-only mode during diff
- `src/renderer/components/chat/ToolCard.tsx` - Added Review Changes button and diff status badge for file tools
- `src/renderer/components/chat/ChatPanel.tsx` - Integrated DiffPreview component
- `src/renderer/styles/chat.css` - Added 30+ CSS rules for diff preview, hunk list, line highlighting, Monaco decorations

## Decisions Made
- **D-96:** Used LCS (Longest Common Subsequence) DP algorithm for diff computation instead of importing an external library like `diff`. The implementation is ~60 lines, handles add/delete/replace classification, and has zero dependency cost. Adequate for file-level diffs in a personal tool.
- **D-97:** Used Monaco deltaDecorations API for inline diff rendering (whole-line className + glyphMarginClassName + overviewRuler) instead of Monaco's built-in DiffEditor. DiffEditor would require a second editor instance and doesn't support per-hunk accept/reject. Decorations integrate seamlessly with the existing EditorPanel.
- **D-98:** Per-hunk accept/reject tracks hunks in the store. When the last hunk in a diff is accepted or rejected, the entire diff is automatically removed from pendingDiffs and activeDiffId is cleared. This prevents empty diffs from accumulating.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Inline diff preview fully functional, completes Phase 7 core interaction features
- DiffStore pattern extensible for future diff-related features (e.g., side-by-side view, diff statistics)
- Monaco decoration pattern reusable for other inline visualizations

---
*Phase: 07-core-interaction*
*Completed: 2026-04-08*

## Self-Check: PASSED

- All 10 files verified present on disk
- All 4 commits (b056c15, d35b32f, 0fe3f77) verified in git log
- Full test suite: 23 test files, 232/232 tests passing
