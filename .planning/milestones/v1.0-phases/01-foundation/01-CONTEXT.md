# Phase 1: Foundation - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the shared type system, IPC communication protocol, and LLM Gateway that all subsequent phases depend on. This phase delivers:

1. **Shared TypeScript types** — message formats, tool definitions, IPC channel types, LLM response types
2. **IPC protocol** — type-safe Main ↔ Renderer communication via Electron's contextBridge
3. **LLM Gateway** — multi-provider streaming API adapter supporting OpenAI-compatible and Anthropic endpoints

No UI, no Agent Loop, no Tool implementations. This is pure infrastructure that Phases 2-4 build upon.

</domain>

<decisions>
## Implementation Decisions

### Provider Strategy
- **D-01:** OpenAI-compatible SDK first (covers OpenAI, DeepSeek, any OpenAI-compatible endpoint) — widest coverage, most models
- **D-02:** Anthropic SDK second (Claude models) — different API format requires separate adapter
- **D-03:** Dual SDK approach (OpenAI SDK + Anthropic SDK) — don't try to abstract into single SDK, API formats are fundamentally different
- **D-04:** Provider adapters normalize to internal unified message format at adapter boundary

### Streaming
- **D-05:** SSE streaming via each SDK's built-in streaming helpers — use OpenAI SDK `.stream()` and Anthropic SDK `client.messages.stream()`
- **D-06:** Internal stream format: AsyncGenerator yielding typed chunks (text delta, tool_use start, tool_use delta, tool_use end, error, done)
- **D-07:** Tool call accumulation: accumulate partial tool_use chunks into complete JSON before passing to executor

### IPC Design
- **D-08:** Typed channels via Electron contextBridge — expose `api.send(channel, data)` and `api.on(channel, handler)` in preload
- **D-09:** Zod validation on IPC boundaries — validate messages at both send and receive points
- **D-10:** All IPC channels defined in shared-types package with full TypeScript inference
- **D-11:** Async channels only — no synchronous IPC calls

### API Key Management
- **D-12:** Store in Electron's safeStorage (OS keychain integration, encrypted on disk) — secure, cross-platform
- **D-13:** Fallback to config file with warning for development
- **D-14:** API keys never leave main process — renderer only sends provider/model selections, main process handles actual API calls

### Model Configuration
- **D-15:** Static model list with preset popular models (GPT-4o, Claude Sonnet, DeepSeek-V3, etc.) — no dynamic model fetching for MVP
- **D-16:** Support custom OpenAI-compatible endpoints via config — user specifies base_url + model_name
- **D-17:** Model config stored in JSON config file at standard Electron user data path

### Project Structure
- **D-18:** Monorepo with packages: shared-types, llm-gateway, ipc-protocol (future: tool-system, agent-runtime)
- **D-19:** Build with electron-vite (not webpack) — faster builds, simpler config
- **D-20:** TypeScript strict mode throughout

### Error Handling
- **D-21:** LLM API errors: exponential backoff with max 3 retries, then surface error to user
- **D-22:** Provider-specific error mapping at adapter level — normalize to internal error types before passing to Agent Runtime

### Claude's Discretion
- Exact file/directory structure within packages
- Internal class hierarchy for providers
- Specific Zod schemas for IPC messages
- Token counting implementation details
- Test framework selection and test structure
- Logging approach

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Claude Code Runtime Reference
- `E:/ai/claude-code/src/query.ts` — Agent conversation loop pattern, streaming response handling, tool call parsing
- `E:/ai/claude-code/src/Tool.ts` — Tool interface definition, input schema pattern, tool result format
- `E:/ai/claude-code/src/tools.ts` — Tool registration and discovery pattern
- `E:/ai/claude-code/src/context/` — Context management patterns (tokenBudget.ts, config.ts)

### Research Documents
- `.planning/research/STACK.md` — Verified library versions and rationale
- `.planning/research/ARCHITECTURE.md` — Component boundaries, data flow, IPC channel design, build order
- `.planning/research/PITFALLS.md` — Critical pitfalls for streaming, context overflow, multi-LLM format differences

### Project Configuration
- `.planning/PROJECT.md` — Vision, constraints, key decisions
- `.planning/REQUIREMENTS.md` — LLM-01 through LLM-06, ELEC-02 requirements
- `.planning/ROADMAP.md` — Phase 1 success criteria and plan slots

</canonical_refs>

<code_context>
## Existing Code Insights

### Reference Codebase (Claude Code at E:\ai\claude-code\)
- **query.ts**: ~700 lines, contains the core conversation loop. Pattern: send messages → parse stream → detect tool_use → execute → loop. Uses Anthropic SDK streaming with tool_use block accumulation.
- **Tool.ts**: ~60 lines, defines the Tool interface. Pattern: `name`, `description`, `inputSchema` (JSON Schema), `execute()` method. Simple and clean.
- **tools.ts**: ~60 lines, tool registration. Conditional loading based on feature flags. MVP doesn't need feature flags.
- **context/tokenBudget.ts**: Token tracking per conversation. Pattern: count tokens after each message, track cumulative usage.

### Reusable Patterns
- Tool interface pattern from Tool.ts — directly applicable to our tool-system package
- Message type union pattern (UserMessage | AssistantMessage | ToolResultMessage) — directly applicable to shared-types
- Tool call accumulation during streaming — critical for LLM Gateway implementation

### Integration Points
- LLM Gateway output format feeds into Agent Runtime (Phase 2)
- IPC protocol types used by both Main and Renderer processes (Phases 3-4)
- Shared types are the foundation for everything

</code_context>

<specifics>
## Specific Ideas

- No specific requirements — Claude has full discretion on implementation approach
- User trusts Claude to make good infrastructure decisions for a personal tool
- Prioritize simplicity and clarity over abstraction — personal tool, not enterprise product

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 01-foundation*
*Context gathered: 2026-04-03*
