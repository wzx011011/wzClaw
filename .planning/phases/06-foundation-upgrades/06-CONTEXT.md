# Phase 6: Foundation Upgrades - Context

**Gathered:** 2026-04-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Conversations survive app restarts (session persistence via JSONL), the agent stays within its token budget (context management with js-tiktoken + auto-compact), and users can invoke any feature via keyboard shortcut (command palette with cmdk).

Three independent subsystems: SessionStore (main process), ContextManager (alongside AgentLoop), CommandRegistry + CommandPalette (renderer). All three can be implemented in parallel waves.

</domain>

<decisions>
## Implementation Decisions

### Session Persistence Strategy
- Auto-save trigger: After each agent turn completes (agent:done event) — matches PERSIST-02, minimal write overhead
- Session file location: `userData/sessions/{sha256(workspaceRoot)}/{conversationId}.jsonl` — matches PERSIST-06, per-project isolation
- JSONL content: Full ChatMessage object (id, role, content, timestamp, toolCalls, usage) — matches PERSIST-04
- Session cleanup: Keep all sessions, user manually deletes — simple, matches personal tool scope

### Context Management Behavior
- Compaction summarization: Simple structured prompt keeping user requests, key decisions, tool results summary, errors encountered
- Context window defaults: GLM 128K, Claude 200K, GPT-4o 128K, DeepSeek 64K — configurable per model in settings (CTX-06)
- Tool result truncation: Hard truncate at 30000 chars with "[truncated {original_length} → 30000 chars]" suffix — matches existing constant
- Token indicator update: After each agent:done event — consistent with auto-save timing

### Command Palette & Built-in Commands
- Command grouping: File (open, save), Session (new, clear, switch), View (toggle sidebar, toggle terminal), Settings (change model, open settings)
- Unavailable commands: Registered with `available: false` flag, shown grayed out with "Coming soon" label
- Fuzzy search: cmdk built-in fuzzy filter — zero extra deps
- /compact handling: Parse in chat input as special command, intercept before sending to agent

### Claude's Discretion
- Exact class structure and method signatures for SessionStore, ContextManager, CommandRegistry
- IPC channel naming conventions for new channels
- Test file organization and fixture patterns
- Specific CSS implementation for components already specified in UI-SPEC.md

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `AgentLoop` (src/main/agent/agent-loop.ts): Holds messages in memory, yields AgentEvent including agent:done with usage data — hook for persistence and token tracking
- `chat-store.ts` (src/renderer/stores/chat-store.ts): Zustand store with ChatMessage interface, init() returns unsubscribe, sendMessage() — extend for session loading/saving
- `ipc-handlers.ts` (src/main/ipc-handlers.ts): Register IPC handlers pattern with Zod validation — add new channels for persistence and context
- `IDELayout.tsx` (src/renderer/components/ide/IDELayout.tsx): Global keydown handler with Ctrl+S and Ctrl+Shift+O — natural place for Ctrl+Shift+P registration
- `SettingsManager` (src/main/settings-manager.ts): safeStorage encryption, load/save pattern — extend for per-model context window config
- `constants.ts` (src/shared/constants.ts): MAX_TOOL_RESULT_CHARS already defined at 30000

### Established Patterns
- IPC: Zod-validated request/response via `IpcSchemas` in shared/ipc-channels.ts
- State management: Zustand stores with `create<StoreType>()` pattern
- Event forwarding: Main → Renderer via `webContents.send(IPC_CHANNELS['stream:*'])`
- Styling: SCSS modules with VS Code Dark+ CSS custom properties
- Testing: vitest with real temp files (os.tmpdir), no mocking of fs

### Integration Points
- `AgentLoop.run()` — inject ContextManager.checkAndCompact() before each gateway.stream() call
- `agent:done` event — trigger SessionStore.save() and token indicator update
- `IDELayout` global keydown — register Ctrl+Shift+P to toggle command palette
- `chat-store.ts` init() — load persisted sessions on startup
- `SettingsManager` — add contextWindowSize to ModelPreset

</code_context>

<specifics>
## Specific Ideas

- UI-SPEC.md already approved with detailed visual specs for: session list (collapsible panel in chat), token indicator (inline bar 60x4px with blue/amber/red thresholds), command palette (520px wide overlay with cmdk), compact result (system message with green border)
- Research recommends js-tiktoken v1.0.21 (pure JS, no native deps) and cmdk v1.1.1 (unstyled, composable)
- Two new npm packages needed: `js-tiktoken` and `cmdk`

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope
</deferred>

---
*Phase: 06-foundation-upgrades*
*Context gathered: 2026-04-08 via Smart Discuss (autonomous mode)*
