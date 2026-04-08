# Phase 7: Core Interaction - Context

**Gathered:** 2026-04-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Users work with multiple AI conversations simultaneously (tabbed sessions with lazy loading), inject specific files into context (@-mention with fuzzy file picker), and review AI code changes with granular accept/reject control (inline Monaco diff with per-hunk actions).

Three integrated subsystems: SessionTabs (renderer, extends chat-store + SessionStore), MentionPicker (renderer, file content injection into messages), DiffPreview (renderer + Monaco integration, per-hunk accept/reject). All build on Phase 6's SessionStore and Phase 4's ChatPanel/ToolCard foundation.

</domain>

<decisions>
## Implementation Decisions

### Multi-Session Tabs
- Tab bar position: Above chat panel (like browser tabs) — matches Cursor's chat sidebar pattern
- Tab management: Right-click context menu (close, close others, rename) + "New Chat" button at end of tab bar
- Active session agent: Only active tab's agent runs; switching tabs loads session from JSONL (lazy)
- New tab creation: "+" button at end of tab bar + Ctrl+T keyboard shortcut

### @-Mention File Injection
- Picker trigger: Dropdown popup below input on "@" — like GitHub mentions, zero learning curve
- Content injection format: Collapsible block in sent message showing filename + content, marked as [context]
- Search/filter: Fuzzy search over relative paths — consistent with cmdk pattern from Phase 6
- Max file size: 100KB limit with warning — prevents blowing context window

### Diff Preview & Accept/Reject
- Diff display: Inline in Monaco editor (like VS Code's inline diff) — users already looking at editor
- Hunk-level UX: Inline action buttons per hunk (Accept / Reject) + toolbar with Accept All / Reject All
- Visual style: Red/green background with +/- line indicators — universal diff convention
- Rejected hunks: Discarded entirely (not written to disk) — clean mental model

### Claude's Discretion
- Exact component hierarchy for SessionTabs, MentionPicker, DiffOverlay
- State management for pending diffs (store vs component state)
- IPC channel naming for new channels
- Monaco editor decorations API usage for inline diff rendering
- Test file organization

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `SessionStore` (src/main/persistence/session-store.ts): JSONL persistence, per-project isolation, load/save session — foundation for multi-session tabs
- `chat-store.ts` (src/renderer/stores/chat-store.ts): Zustand store with ChatMessage, sendMessage, init() — extend for multi-session state
- `ChatPanel.tsx` (src/renderer/components/chat/ChatPanel.tsx): Chat UI with history button, /compact command — extend for tab bar and @-mention
- `ToolCard.tsx` (src/renderer/components/chat/ToolCard.tsx): Already shows file edit previews — foundation for diff visualization
- `CodeBlock.tsx` (src/renderer/components/chat/CodeBlock.tsx): Apply button already inserts code into editor — extend for diff-based apply
- `command-store.ts` (src/renderer/stores/command-store.ts): Pluggable command registry — add new commands for tabs/diff
- `IDELayout.tsx` (src/renderer/components/ide/IDELayout.tsx): Global keydown handler — add Ctrl+T shortcut
- `workspace-store.ts` (src/renderer/stores/workspace-store.ts): File tree with directory listing — reuse for @-mention file picker

### Established Patterns
- IPC: Zod-validated request/response via IpcSchemas in shared/ipc-channels.ts
- State management: Zustand stores with create<StoreType>() pattern
- Styling: CSS with VS Code Dark+ custom properties
- Testing: vitest with real temp files, no mocking of fs
- Tool cards: Inline visualization with collapsible details

### Integration Points
- `ChatPanel.tsx` — add SessionTabs above, MentionPicker in input area, intercept @-mentions
- `chat-store.ts` — add activeSessionId, sessions[] state, loadSession/switchSession actions
- `AgentLoop` — already yields tool_use events for FileWrite/FileEdit — hook into diff preview
- `EditorPanel.tsx` — Monaco decorations API for inline diff rendering
- `workspace-store.ts` — file listing for @-mention picker
- `ipc-channels.ts` — add session:list, session:load, session:delete channels
- `command-store.ts` — register Ctrl+T, session switch commands

</code_context>

<specifics>
## Specific Ideas

- Phase 6's SessionStore already handles JSONL persistence — multi-session tabs just need to list/load sessions
- ToolCard already shows file change previews — DiffPreview is the evolution of this with per-hunk controls
- cmdk from Phase 6 can be reused for the @-mention fuzzy picker (same library, different trigger)
- @-mention should also support @folder to inject all files in a directory

</specifics>

<deferred>
## Deferred Ideas

- @-symbol for code symbols (jump to definition) — deferred to Phase 8
- Tab drag-to-reorder — nice to have but not in success criteria
- Session pinning/favorites — not needed for personal tool

</deferred>

---
*Phase: 07-core-interaction*
*Context gathered: 2026-04-08 via Smart Discuss (autonomous mode)*
