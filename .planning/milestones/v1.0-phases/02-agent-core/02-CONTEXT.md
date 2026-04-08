# Phase 2: Agent Core - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the Agent Runtime that drives multi-turn LLM conversations with tool execution. This phase delivers:

1. **Agent Runtime** — conversation loop that sends messages, receives tool calls, executes tools, feeds results back, and terminates
2. **Tool System** — 6 tools (FileRead, FileWrite, FileEdit, Bash, Grep, Glob) with structured input/output
3. **Permission Model** — destructive operations require user approval via IPC round-trip; read-only tools auto-execute
4. **Safety Guards** — loop detection, iteration cap (25), cancellation support, tool timeout

No UI — the agent runs in the main process and communicates tool approval requests to the renderer via IPC (wired in Phase 4).

</domain>

<decisions>
## Implementation Decisions

### Agent Loop Architecture
- **D-23:** AsyncGenerator pattern for agent loop — consistent with LLM Gateway streaming, yields agent events (text, tool_call, tool_result, done, error)
- **D-24:** In-memory message array per conversation — reset on clear, no file persistence in Phase 2
- **D-25:** Tool results converted to provider-specific format at adapter boundary — internal ToolResult type, adapters translate to OpenAI/Anthropic tool_result message format
- **D-26:** System prompt = static user config + dynamically appended tool descriptions — tools describe their own schemas in system prompt

### Tool System Design
- **D-27:** Tool interface follows Claude Code pattern: name, description, inputSchema (JSON Schema), execute() method returning string + isError flag
- **D-28:** Static tool array registered at startup — no dynamic plugin loading for MVP
- **D-29:** Zod schemas for tool input validation — consistent with D-09 IPC validation pattern
- **D-30:** Tool results as string output + isError boolean — matches ToolResultMessage type in shared/types.ts

### Permission Model
- **D-31:** IPC round-trip to renderer for destructive tool approval — agent sends permission request via IPC, renderer shows approval UI, response comes back via IPC
- **D-32:** Per-tool-type granularity: FileWrite, FileEdit, Bash require approval; FileRead, Grep, Glob auto-execute
- **D-33:** Session-based permission caching — "Allow for session" option lets user approve a tool type once per conversation
- **D-34:** Deny destructive operations when renderer not connected — safe default

### Cancellation & Safety
- **D-35:** AbortController passed through agent loop to LLM Gateway — cancellation propagates cleanly
- **D-36:** 30-second default timeout per tool execution — configurable later
- **D-37:** Loop detection compares tool name + serialized input — catches repeated identical calls, stops after 3+ consecutive
- **D-38:** Error recovery surfaces error to user with retry/abort options — no auto-retry at agent level (LLM Gateway already handles API-level retries per D-21)

### Claude's Discretion
- Exact file/module structure within src/main/
- Tool implementation details (file reading strategy, bash sandboxing on Windows)
- Agent event type definitions
- Internal helper functions and utilities

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/shared/types.ts` — Message, ToolCall, ToolResult, StreamEvent, ToolDefinition types already defined
- `src/shared/ipc-channels.ts` — IPC_CHANNELS constants, payload types, Zod schemas for validation
- `src/shared/constants.ts` — MAX_AGENT_TURNS=25, MAX_FILE_READ_LINES, MAX_TOOL_RESULT_CHARS already defined
- `src/main/llm/gateway.ts` — LLMGateway.stream() returns AsyncGenerator<StreamEvent>, detectProvider(), addProvider()
- `src/main/llm/types.ts` — StreamOptions (model, messages, systemPrompt, maxTokens, tools, abortSignal)
- `src/main/ipc-handlers.ts` — registerIpcHandlers(gateway) with stream forwarding pattern
- `src/preload/index.ts` — contextBridge API with sendMessage, onStreamText, etc.

### Established Patterns
- AsyncGenerator<StreamEvent> for streaming — agent loop should follow same pattern
- Zod validation on boundaries — tool inputs should validate with Zod
- IPC via contextBridge — permission requests follow same channel pattern
- Stream forwarding via sender.send() — agent events forwarded to renderer

### Integration Points
- Agent loop calls gateway.stream() with accumulated messages + tool definitions
- Agent loop yields events that IPC handlers forward to renderer
- Permission model adds new IPC channels (agent:permission_request, agent:permission_response)
- Tool execute() methods run in main process (Node.js fs, child_process access)

</code_context>

<specifics>
## Specific Ideas

- FileEdit must use search-and-replace (old_string/new_string) pattern — reject when old_string no longer matches
- Bash tool needs Windows-specific sandboxing research (flagged in STATE.md)
- Tool descriptions injected into system prompt for LLM to know available tools
- MAX_AGENT_TURNS=25 and MAX_FILE_READ_LINES already defined in constants.ts

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 02-agent-core*
*Context gathered: 2026-04-03*
