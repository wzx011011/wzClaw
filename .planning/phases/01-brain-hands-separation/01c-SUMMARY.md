---
phase: 01-brain-hands-separation
plan: 03
subsystem: brain/agent
tags: [agent-loop, turn-manager, stream-phase, di, decoupling]
dependency_graph:
  requires: [01a-interfaces, 01b-llm-context]
  provides: [decoupled-agent-loop, decoupled-turn-manager, stream-phase, agent-factory]
  affects: [packages/brain/src/agent/*, packages/brain/src/interfaces.ts]
tech_stack:
  added: [IStreamProvider, IContextManager, IObservability, IHookRegistry, IEventSender, ILogger, IHookResult, BRAIN_CHANNELS]
  patterns: [dependency-injection, async-generator-events, factory-function]
key_files:
  created:
    - packages/brain/src/agent/agent-loop.ts
    - packages/brain/src/agent/agent-factory.ts
    - packages/brain/src/agent/system-prompt-builder.ts
    - packages/brain/src/agent/turn-manager.ts
    - packages/brain/src/agent/stream-phase.ts
    - packages/brain/src/channels.ts
    - packages/brain/src/agent/__tests__/agent-loop.test.ts
    - packages/brain/src/agent/__tests__/turn-manager.test.ts
  modified:
    - packages/brain/src/interfaces.ts
    - packages/brain/src/index.ts
decisions:
  - AgentLoop uses IStreamProvider instead of LLMGateway class
  - TurnManager receives ExecuteToolFn from outside, no internal createExecuteToolFn
  - System prompt builder simplified to cache boundary assembly only
  - Tool result disk persistence delegated to Hands layer (brain skips maybePersistLargeToolResult)
  - BRAIN_CHANNELS constants replace IPC_CHANNELS imports
  - IHookRegistry.emit returns IHookResult|void for stop-hook semantics
metrics:
  duration: 893s
  completed: "2026-05-14"
  tasks: 2
  files_created: 8
  files_modified: 2
  tests: 19
---

# Phase 01 Plan 03: Decouple Agent Modules Summary

AgentLoop + TurnManager + StreamPhase refactored to use DI interfaces, zero Electron dependency. All modules accept IStreamProvider, IContextManager, IObservability, IHookRegistry, IEventSender through constructor injection. TurnManager no longer has createExecuteToolFn -- tools execute via externally injected ExecuteToolFn closure.

## Completed Tasks

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Decouple AgentLoop | 4cebe9f | agent-loop.ts, agent-factory.ts, system-prompt-builder.ts, channels.ts, agent-loop.test.ts |
| 2 | Decouple TurnManager + StreamPhase | d8b2bd7 | turn-manager.ts, stream-phase.ts, turn-manager.test.ts |

## Interface Mapping (Desktop -> Brain)

| Desktop Dependency | Brain Interface | Purpose |
|---|---|---|
| `LLMGateway` class | `IStreamProvider` | LLM streaming |
| `ContextManager` class | `IContextManager` | Token counting, compaction |
| `langfuse-observer` (startTrace/endTrace/getActiveTrace) | `IObservability` | Observability |
| `HookRegistry` class | `IHookRegistry` | Hook lifecycle |
| `Electron.WebContents` | `IEventSender` | Event dispatch |
| `DebugLogger` (Electron paths) | `ILogger` | Debug logging |
| `ToolRegistry + PermissionManager + ...` (via createExecuteToolFn) | `ExecuteToolFn` (injected) | Tool execution |
| `IPC_CHANNELS` (from shared/) | `BRAIN_CHANNELS` (local constants) | Channel names |

## Key Decisions

1. **Tool result persistence delegated to Hands**: The brain package skips `maybePersistLargeToolResult` disk writes. The `TurnManager` records `replacementState` decisions (Anthropic prompt cache stability) but does not write files. File system operations belong in the Hands layer.

2. **System prompt builder simplified**: `buildBrainSystemPrompt()` only handles cache boundary concatenation. The full env/git/instruction/memory assembly stays in the desktop app (which has access to git subprocess, file system, etc.).

3. **IHookResult for hook semantics**: Updated `IHookRegistry.emit()` return type from `Promise<void>` to `Promise<IHookResult | void>`, enabling stop-hooks to prevent continuation and inject blocking errors.

4. **AgentLoop tool execution closure**: When a `IToolExecutor` is provided, AgentLoop wraps it with sub-agent event forwarding (via `BRAIN_CHANNELS.SUB_*`) inside the closure. This replaces the old `createExecuteToolFn` that coupled TurnManager to ToolRegistry, PermissionManager, HookRegistry, FileHistoryManager, and Electron.WebContents.

## Deviations from Plan

### Auto-fixed Issues

None -- plan executed as written.

### Plan Adjustments

**1. IHookResult return type**
- **Found during:** Task 1 implementation
- **Issue:** `IHookRegistry.emit()` returned `Promise<void>`, but AgentLoop needed to check `preventContinuation` and `blockingError` from hook results
- **Fix:** Added `IHookResult` interface with optional `preventContinuation` and `blockingError` fields, updated `IHookRegistry.emit()` to return `Promise<IHookResult | void>`
- **Files modified:** interfaces.ts, agent-loop.ts

**2. MicrocompactConfig missing field**
- **Found during:** Task 1 TypeScript compilation
- **Issue:** `getMicrocompactConfig()` returns `{ gapMinutes, keepRecent }` but `maybeTimeBasedMicrocompact` requires `MicrocompactConfig` with `tokenPressureThreshold`
- **Fix:** Spread default `tokenPressureThreshold: 0.80` before the partial config
- **Files modified:** agent-loop.ts

## Test Coverage

- **agent-loop.test.ts**: 10 tests -- DI constructor, text-only response, IEventSender, safety ceiling, cancellation, observability lifecycle, logger, optional deps, hooks
- **turn-manager.test.ts**: 9 tests -- external ExecuteToolFn, pure-data TurnInput, event sequence, StreamPhase import, no createExecuteToolFn, abort handling, turn attachments, shouldStop, loop detection
- **Total**: 19 tests passing

## Self-Check

- All 8 created files verified present
- Both commits (4cebe9f, d8b2bd7) verified in git log
- TypeScript compilation clean (`tsc --noEmit` passes)
- All 19 tests pass (`vitest run` passes)
- Zero Electron imports in brain/src/agent/*.ts (verified by grep)
