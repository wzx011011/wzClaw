---
status: all_fixed
findings_in_scope: 7
fixed: 7
skipped: 0
iteration: 1
---

# Phase 07 Review Fix Report

**Date**: 2026-04-08
**Scope**: CRITICAL and MEDIUM severity findings from `07-REVIEW.md`
**Iteration**: 1

## Summary

All 7 CRITICAL and MEDIUM findings from the Phase 07 code review have been fixed. TypeScript compiles cleanly and all 232 existing tests pass.

## Fixes Applied

### Issue 1: CRITICAL -- Unvalidated File Path in `file:apply-hunk`

**Status**: FIXED
**Commit**: 5267fc5

- Added Zod schema (`IpcSchemas['file:apply-hunk']`) with `filePath`, `hunksToApply`, and `modifiedContent` fields
- Added `safeParse` validation at the handler entry point
- Resolved `filePath` relative to workspace root when it is not absolute
- Added workspace boundary check: rejects paths outside the workspace root with "Access denied" error

### Issue 2: CRITICAL -- Unvalidated File Path in `file:save`

**Status**: FIXED
**Commit**: 5267fc5

- Added Zod schema (`IpcSchemas['file:save']`) with `filePath` and `content` fields
- Added `safeParse` validation at the handler entry point
- Resolved `filePath` relative to workspace root when it is not absolute
- Added workspace boundary check: rejects paths outside the workspace root with "Access denied" error

### Issue 3: CRITICAL -- Synchronous File I/O in Main Process

**Status**: FIXED
**Commit**: b98b2fc

- Converted `appendMessage` from `fs.appendFileSync` to `fs.promises.appendFile`
- Converted `appendMessages` to async: batch-writes all messages in a single `appendFile` call (was per-message sync append in a loop)
- Converted `loadSession` from `fs.readFileSync`/`fs.existsSync` to `fs.promises.readFile` with ENOENT error handling
- Converted `listSessions` from `fs.readdirSync`/`fs.readFileSync`/`fs.statSync` to `fs.promises.readdir`/`readFile`/`stat`
- Converted `deleteSession` from `fs.unlinkSync` to `fs.promises.unlink` with ENOENT handling
- Updated all IPC handlers in `ipc-handlers.ts` to `await` the now-async sessionStore methods
- Replaced the per-message `appendMessage` loop in the `agent:done` handler with `await sessionStore.appendMessages()`

### Issue 4: MEDIUM -- LCS Diff Memory Complexity

**Status**: FIXED
**Commit**: 5ab4937

- Added line-count guard at the top of `computeHunks`: if either original or modified content exceeds `MAX_DIFF_FILE_LINES` (5000, already defined in `constants.ts`), returns empty hunk array with a console warning
- Imported `MAX_DIFF_FILE_LINES` from `shared/constants`

### Issue 5: MEDIUM -- Stale `conversationId` in `switchSession`

**Status**: FIXED
**Commit**: 8785d93

- After calling `await get().loadSession(sessionId)`, the code now checks whether a new error was introduced before updating `activeSessionId`
- If `loadSession` fails (sets `error`), `activeSessionId` is not updated, preventing the mismatch between `activeSessionId` and `conversationId`

### Issue 6: MEDIUM -- Leaking File Change Listeners

**Status**: FIXED
**Commit**: 5267fc5

- Extracted file change forwarding into a named `forwardFileChanges()` function that stores the unsubscribe function in a module-level `fileChangeUnsubscribe` variable
- Before registering a new listener in `workspace:open_folder`, the old listener is cleaned up via `fileChangeUnsubscribe()` and `workspaceManager.offFileChange(callback)`
- Uses the existing `offFileChange` method on `WorkspaceManager` for proper removal

### Issue 7: MEDIUM -- Non-Atomic Session Rename

**Status**: FIXED
**Commit**: b98b2fc

- Converted `renameSession` to async
- Replaced `fs.writeFileSync` with atomic write: content is written to a temp file (`{sessionId}.jsonl.tmp.{timestamp}`) in the same directory, then renamed over the original via `fs.promises.rename`
- `rename` is atomic on most filesystems, preventing data loss if the process crashes mid-write

## Skipped Findings (LOW severity, out of scope)

Issues 8-12 are LOW severity and were not in scope for this fix iteration:

| # | Severity | Summary | Reason Skipped |
|---|----------|---------|----------------|
| 8 | LOW | Double fuzzy match in MentionPicker | Performance optimization, not correctness |
| 9 | LOW | Fragile display content heuristic | Needs design decision on `originalContent` field |
| 10 | LOW | Unbounded sessionsCache | Memory optimization, not correctness |
| 11 | LOW | Type-unsafe decoration storage on editor | Maintainability, not correctness |
| 12 | LOW | DOM-based sidebar toggle | Needs design decision on store architecture |

## Verification

- TypeScript compilation: PASSED (`tsc --noEmit`, zero errors)
- Test suite: PASSED (232 tests across 23 test files, all green)
