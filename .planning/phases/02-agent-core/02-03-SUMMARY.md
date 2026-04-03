---
phase: 02-agent-core
plan: 03
subsystem: agent
tags: [agent-loop, async-generator, tool-execution, loop-detection, message-builder, permissions]

requires:
  - phase: 02-agent-core/02-01
    provides: LLM Gateway, StreamOptions, Tool interface, ToolRegistry with 3 read-only tools
  - phase: 02-agent-core/02-02
    provides: FileWrite, FileEdit, Bash tools, PermissionManager
provides:
  - AgentLoop class with multi-turn conversation orchestration
  - LoopDetector for detecting repeated tool calls (3+ consecutive identical)
  - MessageBuilder for converting internal Message[] to OpenAI and Anthropic formats
  - AgentEvent discriminated union type for agent output streaming
  - AgentConfig interface for agent configuration
  - Updated ToolRegistry with all 6 tools registered
affects: [02-agent-core/02-04, phase-03-chat-panel, phase-04-editor]

tech-stack:
  added: []
  patterns:
    - "AsyncGenerator<AgentEvent> pattern for streaming agent output"
    - "tool_use_start event tracking via Map<string, string> for tool name resolution"
    - "Provider-specific message format conversion at agent boundary"

key-files:
  created:
    - src/main/agent/types.ts
    - src/main/agent/agent-loop.ts
    - src/main/agent/loop-detector.ts
    - src/main/agent/message-builder.ts
    - src/main/agent/__tests__/agent-loop.test.ts
    - src/main/agent/__tests__/loop-detector.test.ts
    - src/main/agent/__tests__/message-builder.test.ts
  modified:
    - src/main/tools/tool-registry.ts
    - src/main/tools/__tests__/tool-registry.test.ts

key-decisions:
  - "D-38: AgentLoop uses tool_use_start events to track tool names since tool_use_end lacks name field"
  - "D-39: Permission denied is non-fatal — tool result with isError=true is fed back to LLM for recovery"
  - "D-40: ToolRegistry now registers all 6 tools (3 read-only + 3 destructive) in createDefaultTools"

patterns-established:
  - "Agent event stream: AsyncGenerator yielding discriminated union events for text, tool calls, results, errors, done"
  - "Loop detection: serialize tool name+input with JSON.stringify, check last 3 entries for consecutive identical calls"
  - "Message building: separate methods per provider format (OpenAI vs Anthropic) with different tool_result schemas"

requirements-completed: [AGNT-01, AGNT-02, AGNT-03, AGNT-04, AGNT-05, AGNT-06]

duration: 14min
completed: 2026-04-03
---

# Phase 02 Plan 03: Agent Loop Summary

Agent Loop with multi-turn tool execution, loop detection (3+ consecutive identical calls), AbortController cancellation, and permission checks for destructive tools, using AsyncGenerator<AgentEvent> for streaming output.

## Performance

- **Duration:** 14 min
- **Started:** 2026-04-03T10:16:49Z
- **Completed:** 2026-04-03T10:30:48Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- AgentLoop orchestrates full multi-turn conversations: user message -> LLM response with tool call -> tool execution -> result fed back -> final text response
- LoopDetector prevents infinite loops by detecting 3+ consecutive identical tool calls
- MessageBuilder converts internal Message[] to both OpenAI and Anthropic wire formats, including tool_result as Anthropic-specific user role with content blocks
- All 6 tools now registered in createDefaultTools (FileRead, Grep, Glob, FileWrite, FileEdit, Bash)

## Task Commits

Each task was committed atomically:

1. **Task 1: Build LoopDetector and MessageBuilder utilities** - `87f237f` (feat)
2. **Task 2: Build AgentLoop with tool execution, permissions, and cancellation** - `9bcdd2c` (feat)

## Files Created/Modified
- `src/main/agent/types.ts` - AgentEvent discriminated union (6 event types) and AgentConfig interface
- `src/main/agent/agent-loop.ts` - Core AgentLoop class with run/cancel/reset/getMessages methods
- `src/main/agent/loop-detector.ts` - LoopDetector class tracking tool call history for loop detection
- `src/main/agent/message-builder.ts` - MessageBuilder converting internal messages to OpenAI/Anthropic formats
- `src/main/agent/__tests__/agent-loop.test.ts` - 10 tests: single-turn, multi-turn, loop detection, max turns, cancellation, tool-not-found, permission approved/denied, auto-approve read-only, reset
- `src/main/agent/__tests__/loop-detector.test.ts` - 9 tests: 3-identical detection, 2-identical not loop, non-consecutive, empty history, reset, serialization, getLastCall, different names
- `src/main/agent/__tests__/message-builder.test.ts` - 15 tests: OpenAI user/assistant/tool_result, Anthropic user/assistant/tool_result, multi-turn, edge cases, system prompt builder
- `src/main/tools/tool-registry.ts` - Updated createDefaultTools to register all 6 tools
- `src/main/tools/__tests__/tool-registry.test.ts` - Updated tests for 6 tools with 3 requiring approval

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Tracked tool names from tool_use_start events**
- **Found during:** Task 2 - AgentLoop implementation
- **Issue:** StreamEvent's ToolUseEndEvent type does not include a `name` field. The plan assumed it would. Without tracking names from tool_use_start, tool calls would have empty names.
- **Fix:** Added a `toolNameMap` (Map<string, string>) in the streaming loop to track tool names by id from tool_use_start events, then resolve them in tool_use_end events.
- **Files modified:** `src/main/agent/agent-loop.ts`
- **Commit:** `9bcdd2c`

**2. [Rule 3 - Blocking] Updated existing tool-registry tests for 6 tools**
- **Found during:** Task 2 - after updating createDefaultTools to register all 6 tools
- **Issue:** Existing tool-registry tests expected only 3 read-only tools. The plan called for registering all 6 tools, which broke the "no tools require approval" test.
- **Fix:** Updated test expectations to reflect 6 tools with 3 requiring approval (FileWrite, FileEdit, Bash). Added 3 new test cases for destructive tools.
- **Files modified:** `src/main/tools/__tests__/tool-registry.test.ts`
- **Commit:** `9bcdd2c`

## Test Results

- **Total tests:** 144 (34 new + 110 existing)
- **Test files:** 16 passed
- **New test coverage:**
  - `agent-loop.test.ts`: 10 tests
  - `loop-detector.test.ts`: 9 tests
  - `message-builder.test.ts`: 15 tests
  - `tool-registry.test.ts`: +3 tests (now 12 total)

## Architecture Notes

The AgentLoop follows this flow:
1. User message added to internal message array
2. System prompt built with tool descriptions appended (D-26)
3. Provider detected from model name (claude* -> anthropic, else -> openai)
4. Messages converted to provider-specific format via MessageBuilder
5. LLM Gateway streams events; text deltas yielded immediately
6. Tool calls accumulated from stream (start/end events)
7. For each tool call: check loop detection, check registry, check permissions, execute
8. Tool results added to messages, loop continues until text-only response or guard triggers

## Self-Check: PASSED

All 8 created/modified files verified present. Both task commits (87f237f, 9bcdd2c) verified in git log.
