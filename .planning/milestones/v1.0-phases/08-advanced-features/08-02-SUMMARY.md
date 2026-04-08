---
phase: 08-advanced-features
plan: 02
subsystem: tools
tags: [web-search, web-fetch, duckduckgo, monaco, symbol-nav, ipc, toolcard, html-to-text]

# Dependency graph
requires:
  - phase: 08-advanced-features
    plan: 01
    provides: Terminal panel and IDELayout with Allotment layout
  - phase: 04-chat-panel-integration
    provides: ToolCard component with file tool rendering, chat panel CSS
  - phase: 02-agent-core
    provides: Tool interface, ToolRegistry, ToolExecutionContext
provides:
  - WebSearchTool using DuckDuckGo Instant Answer API (no API key required)
  - WebFetchTool with HTML-to-text conversion and 15K char truncation
  - GoToDefinitionTool, FindReferencesTool, SearchSymbolsTool via Monaco IPC
  - SymbolService renderer component for Monaco TypeScript worker access
  - Symbol IPC channels (symbol:query, symbol:result) with request/response types
  - ToolCard special rendering for WebSearch, WebFetch, and symbol navigation tools
  - Rate limiting (3s gap) for web requests
affects: [tools, chat-panel, editor-panel, ipc]

# Tech tracking
tech-stack:
  added: []
  patterns: [ipc-round-trip-promise, shared-pending-queries-map, html-to-text-inline, rate-limit-static-state]

key-files:
  created:
    - src/main/tools/web-search.ts
    - src/main/tools/web-fetch.ts
    - src/main/tools/symbol-nav.ts
    - src/main/tools/__tests__/web-search.test.ts
    - src/main/tools/__tests__/web-fetch.test.ts
    - src/main/tools/__tests__/symbol-nav.test.ts
    - src/renderer/components/ide/SymbolService.tsx
  modified:
    - src/main/tools/tool-registry.ts
    - src/shared/ipc-channels.ts
    - src/shared/constants.ts
    - src/preload/index.ts
    - src/main/ipc-handlers.ts
    - src/main/index.ts
    - src/renderer/components/chat/ToolCard.tsx
    - src/renderer/styles/chat.css

key-decisions:
  - "D-TOOL-01: DuckDuckGo Instant Answer API for web search -- free, no API key, good enough for MVP"
  - "D-TOOL-02: 3 separate symbol tools (GoToDefinition, FindReferences, SearchSymbols) instead of one multi-operation tool for cleaner agent UX"
  - "D-TOOL-03: SymbolService as hidden component inside EditorPanel subscribes to IPC queries via Monaco TypeScript worker"
  - "D-TOOL-04: SearchSymbols uses regex over all open Monaco models as fallback when TypeScript worker unavailable"
  - "D-TOOL-05: Shared pendingQueries Map in symbol-nav.ts handles IPC round-trip resolution with 10s timeout"
  - "D-TOOL-06: Rate limiting uses static module-level lastRequestTime for simplicity across all web tool instances"

patterns-established:
  - "IPC round-trip promise: pendingQueries Map with queryId-based resolution, cleanup on timeout or response"
  - "Symbol fallback chain: TypeScript worker primary, regex text search fallback for non-TS files"

requirements-completed: [TOOL-09, TOOL-10, TOOL-11]

# Metrics
duration: 15min
completed: 2026-04-08
---

# Phase 8 Plan 02: Web Search/Fetch and Symbol Navigation Tools Summary

**Web search via DuckDuckGo API, web page fetching with HTML-to-text conversion, and code symbol navigation (GoToDefinition, FindReferences, SearchSymbols) via Monaco TypeScript worker IPC**

## Performance

- **Duration:** 15 min
- **Started:** 2026-04-08T08:27:21Z
- **Completed:** 2026-04-08T08:42:31Z
- **Tasks:** 2
- **Files modified:** 14

## Accomplishments
- WebSearchTool uses DuckDuckGo Instant Answer API (free, no API key needed) with 3-second rate limiting
- WebFetchTool converts HTML to readable text with script/style tag removal, entity decoding, and 15K char truncation
- Three symbol navigation tools (GoToDefinition, FindReferences, SearchSymbols) communicate with Monaco TypeScript worker via IPC round-trip pattern
- SymbolService renderer component mounted as hidden component inside EditorPanel handles all Monaco API calls
- ToolCard renders search results with clickable URLs, fetched content with expand/collapse, and symbol results with kind badges

## Task Commits

Each task was committed atomically:

1. **Task 1: WebSearch + WebFetch tools + ToolCard rendering** - `d825df5` (feat)
2. **Task 2: SymbolNav tools + IPC + ToolCard rendering** - `f29fa54` (feat)
3. **Task 2 fix: update tool-registry test for 8 core tools + 3 symbol tools** - `3fa5745` (fix)

## Files Created/Modified
- `src/main/tools/web-search.ts` - WebSearchTool: DuckDuckGo API search, rate limiting, structured result formatting
- `src/main/tools/web-fetch.ts` - WebFetchTool: URL fetch, HTML-to-text conversion, entity decoding, truncation
- `src/main/tools/symbol-nav.ts` - GoToDefinitionTool, FindReferencesTool, SearchSymbolsTool: IPC round-trip with Monaco, 10s timeout, shared pendingQueries Map
- `src/main/tools/__tests__/web-search.test.ts` - 8 tests: name, description, approval, input validation, DDG response parsing, error handling, rate limiting
- `src/main/tools/__tests__/web-fetch.test.ts` - 9 tests: name, description, approval, URL validation, HTML stripping, truncation, error handling
- `src/main/tools/__tests__/symbol-nav.test.ts` - 12 tests: name, description, approval, input validation, timeout behavior for all 3 tools
- `src/renderer/components/ide/SymbolService.tsx` - Hidden component subscribing to symbol:query IPC, calling Monaco TypeScript worker, fallback regex search
- `src/main/tools/tool-registry.ts` - Added WebSearch, WebFetch imports; createDefaultTools accepts getWebContents param, conditionally registers 3 symbol tools
- `src/shared/ipc-channels.ts` - Added symbol:query and symbol:result channels with request/response/stream payload types
- `src/shared/constants.ts` - Added WEB_CONTENT_MAX_CHARS (15000), WEB_FETCH_TIMEOUT_MS (15000), WEB_SEARCH_RATE_LIMIT_MS (3000)
- `src/preload/index.ts` - Added onSymbolQuery and sendSymbolResult methods
- `src/main/ipc-handlers.ts` - Added symbol:result handler that calls handleSymbolResult from symbol-nav.ts
- `src/main/index.ts` - Passes getWebContents function to createDefaultTools
- `src/renderer/components/chat/ToolCard.tsx` - Added special rendering for WebSearch (clickable URLs), WebFetch (expand/collapse content), symbol tools (kind badges)
- `src/renderer/styles/chat.css` - Added web result, URL, title, snippet, source, content CSS classes

## Decisions Made
- DuckDuckGo Instant Answer API chosen for web search -- free, no API key, returns structured JSON with RelatedTopics (D-TOOL-01)
- Three separate symbol tools instead of one multi-operation tool for cleaner agent UX and simpler input schemas (D-TOOL-02)
- SymbolService as hidden React component inside EditorPanel rather than standalone service -- shares editorRef directly (D-TOOL-03)
- SearchSymbols uses regex-based identifier matching over all open Monaco models as fallback when TypeScript worker is unavailable (D-TOOL-04)
- Shared pendingQueries Map with queryId-based resolution pattern handles IPC round-trip with automatic timeout cleanup (D-TOOL-05)
- Rate limiting uses static module-level state (simple, no need for per-instance tracking) (D-TOOL-06)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Tool-registry test not updated for new symbol tool count**
- **Found during:** Task 2 (test verification)
- **Issue:** Existing tool-registry test expected a specific number of registered tools that did not account for the 3 new symbol tools
- **Fix:** Updated test to expect 8 core tools + 3 conditional symbol tools
- **Files modified:** src/main/tools/__tests__/tool-registry.test.ts
- **Verification:** All tests pass (29/29)
- **Committed in:** 3fa5745

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Minimal -- test count adjustment to match new tool registrations.

## Issues Encountered
- WebSearch tests are slow (~3s each) due to rate limiting enforcement in tests. This is expected behavior and validates the rate limiter works correctly.
- WebFetch tests similarly slow (~3s each) for the same reason.

## Next Phase Readiness
- All 5 new tools (WebSearch, WebFetch, GoToDefinition, FindReferences, SearchSymbols) registered and functional
- Symbol navigation depends on Monaco TypeScript worker being available in renderer
- Web search uses free DuckDuckGo API -- upgrade path to Brave/SerpAPI for better results is clear
- Plan 08-03 (codebase indexing) can build on the symbol navigation infrastructure

---
*Phase: 08-advanced-features*
*Completed: 2026-04-08*

## Self-Check: PASSED

- FOUND: src/main/tools/web-search.ts
- FOUND: src/main/tools/web-fetch.ts
- FOUND: src/main/tools/symbol-nav.ts
- FOUND: src/main/tools/__tests__/web-search.test.ts
- FOUND: src/main/tools/__tests__/web-fetch.test.ts
- FOUND: src/main/tools/__tests__/symbol-nav.test.ts
- FOUND: src/renderer/components/ide/SymbolService.tsx
- FOUND: d825df5 (Task 1 commit)
- FOUND: f29fa54 (Task 2 commit)
- FOUND: 3fa5745 (Task 2 fix commit)
- Tests: 29/29 passing
- TypeScript: clean compilation
