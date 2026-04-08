---
phase: "01"
plan: "02"
subsystem: llm-gateway
tags: [streaming, openai, anthropic, adapter-pattern, tool-calls]
dependency_graph:
  requires: ["01-01 (shared types)"]
  provides: ["LLMGateway", "OpenAIAdapter", "AnthropicAdapter", "StreamOptions", "ProviderConfig"]
  affects: ["02-01 (agent runtime)", "03-01 (IPC agent handlers)"]
tech_stack:
  added: ["openai@^6.0.0", "@anthropic-ai/sdk@^0.82.0"]
  patterns: ["AsyncGenerator<StreamEvent>", "tool call accumulation", "provider detection by model name"]
key_files:
  created:
    - src/main/llm/types.ts
    - src/main/llm/gateway.ts
    - src/main/llm/openai-adapter.ts
    - src/main/llm/anthropic-adapter.ts
    - src/main/llm/__tests__/openai-adapter.test.ts
    - src/main/llm/__tests__/anthropic-adapter.test.ts
    - src/main/llm/__tests__/gateway.test.ts
  modified: []
decisions:
  - OpenAI adapter system prompt injected as first message (role: system) in messages array
  - Anthropic system prompt sent as separate top-level system field per API spec
  - Anthropic max_tokens defaults to 8192 when not specified
  - Gateway detectProvider routes claude* to anthropic, everything else to openai
  - Tool call JSON parsed on finish_reason=tool_calls (OpenAI) or content_block_stop (Anthropic)
  - Both adapters yield error events instead of throwing to allow agent loop graceful handling
metrics:
  duration: 9m
  completed: "2026-04-03"
---

# Phase 01 Plan 02: LLM Gateway with OpenAI + Anthropic Adapters Summary

Unified LLM Gateway with dual-provider streaming adapters. OpenAI adapter accumulates tool calls from partial JSON chunks in delta.tool_calls. Anthropic adapter tracks content_block_start/delta/stop events for text and tool use. Gateway routes by model name prefix (claude* -> anthropic, else -> openai). All 36 tests pass (14 shared + 22 new).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 01-02-01 | Create LLM Gateway types and interface | 2832524 | types.ts, gateway.ts, openai-adapter.ts, anthropic-adapter.ts |
| 01-02-02 | OpenAI adapter with streaming and tool call accumulation | 2d8f8b6 | openai-adapter.test.ts |
| 01-02-03 | Anthropic adapter with streaming and tool call accumulation | 9eea4e8 | anthropic-adapter.test.ts |
| 01-02-04 | Gateway integration tests | dd1b546 | gateway.test.ts |

## Test Results

- **36 tests passing** across 5 test files
- OpenAI adapter: 6 tests (text streaming, tool call accumulation, error handling, system prompt, tools passthrough, API errors)
- Anthropic adapter: 7 tests (text streaming, tool accumulation, max_tokens default, system prompt, error handling, mixed text+tool)
- Gateway: 9 tests (provider detection for gpt/deepseek/claude, addProvider, getAdapter, missing provider error, unknown provider throw)
- Shared types: 14 tests (pre-existing, still passing)

## Key Implementation Details

### Provider Detection
Gateway.detectProvider() routes models starting with "claude" to the Anthropic adapter. All other model names (gpt-*, deepseek-*, etc.) route to the OpenAI adapter. This covers DeepSeek, OpenAI, and any OpenAI-compatible endpoint with a single adapter.

### Tool Call Accumulation (OpenAI)
OpenAI streams tool call arguments as partial JSON strings in `delta.tool_calls[i].function.arguments`. The adapter maintains a `Map<number, ToolCallAccumulator>` keyed by chunk index. Arguments are concatenated across chunks. On `finish_reason === 'tool_calls'`, each accumulator's JSON is parsed and yielded as `tool_use_start` + `tool_use_end` events.

### Tool Call Accumulation (Anthropic)
Anthropic uses content block events: `content_block_start` with `type: 'tool_use'` initiates a tool call, `content_block_delta` with `type: 'input_json_delta'` delivers partial JSON, and `content_block_stop` signals completion. The adapter tracks accumulators by content block index and parses the accumulated JSON on stop.

### System Prompt Handling
- OpenAI: Injected as the first message with `role: 'system'` in the messages array
- Anthropic: Sent as the top-level `system` field per Anthropic API specification. System messages are filtered from the messages array.

### Error Handling
Both adapters wrap their entire stream in try/catch and yield `{ type: 'error', error: message }` instead of throwing. This allows the agent loop (Phase 2) to handle errors gracefully without crashing.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None - all data paths are fully wired to SDK mock calls in tests and real SDK calls in production.

## Self-Check: PASSED

- FOUND: src/main/llm/types.ts
- FOUND: src/main/llm/gateway.ts
- FOUND: src/main/llm/openai-adapter.ts
- FOUND: src/main/llm/anthropic-adapter.ts
- FOUND: src/main/llm/__tests__/openai-adapter.test.ts
- FOUND: src/main/llm/__tests__/anthropic-adapter.test.ts
- FOUND: src/main/llm/__tests__/gateway.test.ts
- FOUND: 2832524 (types + gateway + adapters)
- FOUND: 2d8f8b6 (OpenAI adapter tests)
- FOUND: 9eea4e8 (Anthropic adapter tests)
- FOUND: dd1b546 (Gateway tests)
- 36/36 tests passing
