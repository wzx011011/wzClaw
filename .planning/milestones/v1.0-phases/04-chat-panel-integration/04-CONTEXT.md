# Phase 4: Chat Panel + Integration - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the chat panel UI that connects users to the AI agent, plus settings management and end-to-end integration. This phase delivers:

1. **Chat Panel** — Right sidebar with streaming responses, markdown rendering, code apply
2. **Tool Visualization** — Inline cards showing tool calls with status, collapsible details, file diffs
3. **Settings Panel** — Modal for API keys (safeStorage encrypted), provider/model switching
4. **Conversation Controls** — Stop generation, clear/reset conversation

This is the phase that makes the app actually usable as an AI coding tool.

</domain>

<decisions>
## Implementation Decisions

### Chat UI Layout
- **D-57:** Chat panel as right sidebar (resizable)
- **D-58:** Token-by-token streaming display with typing cursor
- **D-59:** Markdown rendering with code syntax highlighting (react-markdown + rehype-highlight)
- **D-60:** "Apply" button on code blocks that inserts code into active editor tab

### Tool Call Visualization
- **D-61:** Inline tool cards in chat stream (tool name, params, result)
- **D-62:** Collapsible tool input/output with summary always visible
- **D-63:** Status badges: spinner → ✓/✗ for tool execution status
- **D-64:** FileEdit/FileWrite show diff-style before/after preview

### Settings & Conversation Controls
- **D-65:** Modal settings dialog (gear icon in chat header)
- **D-66:** Electron safeStorage for API keys (encrypted, per-provider)
- **D-67:** Provider/model dropdown in chat header for live switching mid-conversation
- **D-68:** Stop button during generation + Clear button to reset conversation

### Claude's Discretion
- Chat message component design
- Tool card component hierarchy
- Settings form layout
- Conversation store structure
- Code block parsing and Apply logic

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/renderer/stores/workspace-store.ts` — Zustand workspace store (pattern reference)
- `src/renderer/stores/tab-store.ts` — Zustand tab store with save/refresh (pattern reference)
- `src/renderer/components/ide/IDELayout.tsx` — Root layout (chat panel goes here)
- `src/renderer/components/ide/EditorPanel.tsx` — Monaco editor (Apply inserts here)
- `src/shared/ipc-channels.ts` — Has agent:send_message, stream:*, settings:* channels
- `src/preload/index.ts` — Has sendMessage, onStreamText, onStreamToolStart/End, getSettings, updateSettings
- `src/main/ipc-handlers.ts` — Has full agent loop wired with permission handling
- `src/main/agent/agent-loop.ts` — AgentLoop yields AgentEvents
- `src/main/agent/types.ts` — AgentEvent types (text, tool_call, tool_result, permission_request, done, error)

### Established Patterns
- Zustand stores with IPC integration
- React components in src/renderer/components/
- IPC events via preload bridge's onStream* listeners
- Stream forwarding from main → renderer

### Integration Points
- Chat panel sits in IDELayout as a resizable right panel
- Chat store calls window.wzxclaw.sendMessage() and listens to stream events
- Settings modal calls window.wzxclaw.updateSettings() with provider/model/apiKey
- Apply button calls tab store's openOrRefreshTab or inserts into Monaco
- Stop button calls window.wzxclaw.stopGeneration()

</code_context>

<specifics>
## Specific Ideas

- No specific requirements — make it functional and clean
- Chat panel is the primary user interaction surface
- Tool visualization is key differentiator vs simple chat UIs

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 04-chat-panel-integration*
*Context gathered: 2026-04-03*
