---
phase: 09-codebase-indexing
plan: 02
subsystem: indexing
tags: [semantic-search, tool-registry, ipc-channels, indexing-engine, app-lifecycle]

# Dependency graph
requires:
  - phase: 09-codebase-indexing
    provides: "IndexingEngine, EmbeddingClient, VectorStore, CodeChunker (from Plan 01)"
provides:
  - "SemanticSearchTool for agent-invoked semantic code search"
  - "IPC channels and handlers for index status, re-index, and UI search"
  - "App lifecycle wiring: IndexingEngine created on workspace open, incremental updates on file change, progress forwarding"
affects: [09-codebase-indexing, agent-loop, tool-system]

# Tech tracking
tech-stack:
  added: []
  patterns: [setter-injection-for-lazy-init, mutable-ref-wrapper-for-late-binding, workspace-lifecycle-callback]

key-files:
  created:
    - src/main/tools/semantic-search.ts
    - src/main/tools/__tests__/semantic-search.test.ts
  modified:
    - src/main/tools/tool-registry.ts
    - src/shared/ipc-channels.ts
    - src/main/ipc-handlers.ts
    - src/main/index.ts
    - src/main/tools/__tests__/tool-registry.test.ts
    - src/main/__tests__/integration.test.ts

key-decisions:
  - "D-IDX-06: Setter injection pattern for IndexingEngine on SemanticSearchTool -- tool created before workspace is open, engine reference set later"
  - "D-IDX-07: Mutable ref wrapper (indexingEngineRef) in ipc-handlers.ts -- allows workspace switch to replace the engine without re-registering handlers"
  - "D-IDX-08: onWorkspaceOpened callback from ipc-handlers to index.ts -- avoids circular dependency, index.ts owns engine lifecycle"

patterns-established:
  - "Setter injection for late-bound dependencies: tool created at startup, receives engine reference after workspace opens"
  - "Mutable ref wrapper pattern: { current: value } passed to handlers allows the owning module to swap the reference"
  - "Workspace lifecycle callback: IPC handler notifies owner when workspace opens, owner creates/replaces engine"

requirements-completed: [IDX-01, IDX-04, IDX-05]

# Metrics
duration: 6min
completed: 2026-04-08
---

# Phase 9 Plan 2: SemanticSearch Tool and Index Lifecycle Summary

**SemanticSearchTool with setter injection for lazy IndexingEngine binding, IPC channels for index operations, and automatic full/incremental indexing on workspace lifecycle events**

## Performance

- **Duration:** 6 min
- **Started:** 2026-04-08T10:34:24Z
- **Completed:** 2026-04-08T10:40:56Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- SemanticSearchTool validates input with Zod, formats results with file paths/line ranges/scores, truncates at MAX_TOOL_RESULT_CHARS
- Tool uses setter injection pattern: IndexingEngine reference set after workspace opens (not available at startup)
- IPC channels (index:status, index:reindex, index:search) with typed request/response payloads and index:progress stream
- IndexingEngine created lazily on workspace open, disposed on quit, with incremental updates on file change events
- Integration test suite updated for new tool count and expanded registerIpcHandlers signature

## Task Commits

Each task was committed atomically:

1. **Task 1: Create SemanticSearch tool and update tool registry** - `23d52ad` (feat)
2. **Task 2: Add IPC channels and wire IndexingEngine into app lifecycle** - `3ef3aab` (feat)

## Files Created/Modified
- `src/main/tools/semantic-search.ts` - SemanticSearchTool implementing Tool interface with IndexingEngine setter injection
- `src/main/tools/__tests__/semantic-search.test.ts` - 10 tests covering validation, search results, truncation, error handling
- `src/main/tools/tool-registry.ts` - Added indexingEngine parameter to createDefaultTools, registered SemanticSearchTool
- `src/shared/ipc-channels.ts` - Added index:status, index:reindex, index:search channels and index:progress stream
- `src/main/ipc-handlers.ts` - Added index IPC handlers, indexingEngine parameter, mutable ref wrapper, onWorkspaceOpened callback
- `src/main/index.ts` - IndexingEngine lifecycle: create on workspace open, incremental updates on file change, dispose on quit
- `src/main/tools/__tests__/tool-registry.test.ts` - Updated tool counts (9 base, 12 with getWebContents)
- `src/main/__tests__/integration.test.ts` - Fixed tool count, registerIpcHandlers signature, added ipcMain.on mock

## Decisions Made
- Setter injection for IndexingEngine on SemanticSearchTool: the tool is created at app startup before any workspace is open, so the engine reference must be set later. Uses `setIndexingEngine()` method.
- Mutable ref wrapper in ipc-handlers.ts: `indexingEngineRef = { current: indexingEngine }` allows the workspace-open callback in index.ts to replace the engine without re-registering IPC handlers.
- onWorkspaceOpened callback pattern: ipc-handlers.ts calls back to index.ts when workspace opens, letting index.ts own the IndexingEngine lifecycle (create, dispose, progress forwarding) while avoiding circular imports.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed integration test tool count and IPC handler registration**
- **Found during:** Task 2 (verification)
- **Issue:** Integration tests still expected 6 tools (from before SemanticSearch was added in Task 1) and called registerIpcHandlers with the old 5-parameter signature. Also missing ipcMain.on mock for symbol:result handler.
- **Fix:** Updated tool count assertions to 9, added all required mock components (contextManager, terminalManager, taskManager), added ipcMain.on to electron mock, added index channel assertions.
- **Files modified:** src/main/__tests__/integration.test.ts
- **Verification:** 12/12 integration tests pass, 22/22 plan-related tests pass
- **Committed in:** `3ef3aab` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Bug fix necessary for test correctness. No scope creep.

## Issues Encountered
- Pre-existing toggle-terminal command-store test failure (unrelated to this plan, Phase 6/8 artifact) -- logged as out of scope, not fixed.

## Known Stubs
None -- SemanticSearchTool gracefully handles missing IndexingEngine with a helpful error message telling the user to open a workspace.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- SemanticSearch tool fully integrated into agent loop and available for use
- Indexing starts automatically when workspace opens, stays up-to-date via file change events
- Ready for Plan 03: Index status UI (progress indicator, status bar integration)
- EmbeddingClient needs real API key configuration for production use (currently uses TF-IDF fallback)

---
*Phase: 09-codebase-indexing*
*Completed: 2026-04-08*
