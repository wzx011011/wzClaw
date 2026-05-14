---
phase: 01-brain-hands-separation
plan: 02
subsystem: brain
tags: [llm, context, gateway, adapter, token-counter, microcompact]
dependency_graph:
  requires: ["01-brain-hands-separation-01"]
  provides: ["brain-llm-layer", "brain-context-layer"]
  affects: ["packages/brain"]
tech_stack:
  added:
    - "openai ^6.0.0"
    - "@anthropic-ai/sdk ^0.82.0"
    - "js-tiktoken ^1.0.21"
  patterns:
    - "LLM provider routing via detectProvider + adapter map"
    - "Tool result path injection via ToolResultStorageConfig interface"
key_files:
  created:
    - packages/brain/src/constants.ts
    - packages/brain/src/llm/gateway.ts
    - packages/brain/src/llm/openai-adapter.ts
    - packages/brain/src/llm/anthropic-adapter.ts
    - packages/brain/src/llm/cost-tracker.ts
    - packages/brain/src/llm/model-cost.ts
    - packages/brain/src/context/types.ts
    - packages/brain/src/context/token-counter.ts
    - packages/brain/src/context/context-manager.ts
    - packages/brain/src/context/microcompact.ts
    - packages/brain/src/context/tool-result-budget.ts
    - packages/brain/src/context/tool-result-storage.ts
    - packages/brain/src/context/turn-attachments.ts
    - packages/brain/src/context/compact-file-restore.ts
  modified:
    - packages/brain/package.json
    - packages/brain/src/index.ts
decisions:
  - "Anthropic adapter uses double-cast (as unknown as Record) for SDK types that lack index signatures"
  - "tool-result-storage refactored to accept ToolResultStorageConfig with baseDir injection instead of Electron paths module"
  - "CompactResult kept in types.ts (shared with interfaces.ts), re-exported from context/types.ts"
metrics:
  duration_minutes: 14
  completed: "2026-05-14"
  tasks_completed: 2
  files_created: 14
  files_modified: 2
---

# Phase 1 Plan 01b: LLM + Context Layer Summary

LLM Gateway with OpenAI/Anthropic adapters and full Context management subsystem copied into brain package with import path migration and Electron dependency removal.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Copy LLM Layer | 8b3f55f | gateway.ts, openai-adapter.ts, anthropic-adapter.ts, cost-tracker.ts, model-cost.ts, constants.ts |
| 2 | Copy Context Layer | 943613d | context-manager.ts, token-counter.ts, microcompact.ts, tool-result-budget.ts, tool-result-storage.ts, turn-attachments.ts, compact-file-restore.ts |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Anthropic SDK strict type casting errors**
- **Found during:** Task 1
- **Issue:** The Anthropic SDK v0.82.0 has strict types that reject `Record<string, unknown>` casts for content blocks, deltas, and usage objects
- **Fix:** Changed all `as Record<string, unknown>` to `as unknown as Record<string, unknown>` for SDK types that lack index signatures. Used `Parameters<typeof>` for stream method params.
- **Files modified:** packages/brain/src/llm/anthropic-adapter.ts
- **Commit:** 8b3f55f

**2. [Rule 2 - Missing Functionality] Tool-result-storage Electron path dependency**
- **Found during:** Task 2
- **Issue:** Original tool-result-storage.ts imported `getToolResultsDir` from Electron's `paths.ts` module
- **Fix:** Created `ToolResultStorageConfig` interface with `baseDir` property. All public functions now accept config as first parameter instead of calling Electron paths.
- **Files modified:** packages/brain/src/context/tool-result-storage.ts
- **Commit:** 943613d

**3. [Rule 2 - Missing Functionality] Duplicate CompactResult export**
- **Found during:** Task 2
- **Issue:** CompactResult defined in both types.ts and context/types.ts, causing TS2300 duplicate identifier
- **Fix:** Made context/types.ts re-export from ../types.js instead of re-declaring the interface
- **Files modified:** packages/brain/src/context/types.ts, packages/brain/src/index.ts
- **Commit:** 943613d

## Verification Results

- `npx tsc --noEmit` — zero errors
- `grep -rn "electron\|../../shared" src/` — zero matches
- `npm install` — 7 packages added (openai, @anthropic-ai/sdk, js-tiktoken + transitive deps)

## Threat Flags

No new threat surface introduced. All modules are pure logic with no network endpoints, auth paths, or file access beyond what was already present in the desktop source.

## Known Stubs

None.

## Self-Check: PASSED

All 14 created files verified present. Both task commits (8b3f55f, 943613d) confirmed in git log.
