---
phase: 07-core-interaction
researched: 2026-04-08
status: complete
---

# Phase 7: Core Interaction - Research

## Domain Analysis

Phase 7 builds three user-facing features on top of Phase 6's foundation:
1. Multi-session tab management (extends SessionStore)
2. @-mention file injection (new file picker + message enhancement)
3. Inline diff preview with per-hunk accept/reject (Monaco decorations)

## Existing Codebase

### SessionStore (Phase 6)
- `src/main/persistence/session-store.ts` — JSONL read/write, per-project isolation
- `src/renderer/components/chat/SessionList.tsx` — collapsible history panel
- `src/renderer/stores/chat-store.ts` — Zustand with ChatMessage, sendMessage, init()
- Sessions stored at `userData/sessions/{sha256(workspaceRoot)}/{conversationId}.jsonl`

### Chat & Tool System
- `src/renderer/components/chat/ChatPanel.tsx` — main chat UI with history button
- `src/renderer/components/chat/ChatMessage.tsx` — message rendering
- `src/renderer/components/chat/ToolCard.tsx` — tool call visualization with collapsible details
- `src/renderer/components/chat/CodeBlock.tsx` — code rendering with Apply button
- `src/main/agent/agent-loop.ts` — yields AgentEvents including tool_use/tool_result
- `src/main/tools/file-write.ts` — FileWrite tool
- `src/main/tools/file-edit.ts` — FileEdit tool

### UI Components
- `src/renderer/components/ide/IDELayout.tsx` — root layout, global keydown handler
- `src/renderer/components/ide/EditorPanel.tsx` — Monaco editor wrapper
- `src/renderer/stores/workspace-store.ts` — file tree with directory listing
- `src/renderer/stores/command-store.ts` — pluggable command registry (Phase 6)
- cmdk library already installed (Phase 6, used for command palette)

## Technical Research

### Multi-Session Tabs

**Approach:** Add `activeSessionId` and `sessions[]` to chat-store.ts. Each session is a lightweight object with id, title, lastActivity. Tab bar component renders sessions as tabs. Switching tabs triggers `loadSession(id)` which reads from SessionStore via IPC.

**Key patterns:**
- Zustand already manages chat state — extend with multi-session fields
- SessionStore already has `loadSession()` and `listSessions()` methods
- Lazy loading: only load messages when tab is activated
- Agent loop is already per-session (each sendMessage includes conversationId)

**IPC needed:**
- `session:list` — return all sessions for current workspace
- `session:load` — load full session with messages
- `session:delete` — delete session file
- `session:rename` — update session title

### @-Mention File Injection

**Approach:** Intercept "@" in chat input, show dropdown with fuzzy file search. Selected file's content is embedded in the message as a special content block. The LLM receives file content as part of the user message.

**Key patterns:**
- cmdk already provides fuzzy search — reuse for file picker
- workspace-store already has file tree data — reuse for file listing
- ChatMessage already renders different content types — add collapsible file block
- Agent's message format supports rich content via content blocks

**Content injection format:**
```typescript
interface FileMention {
  type: 'file_mention';
  path: string;
  content: string;
  size: number;
}
```
- Added to ChatMessage.content array
- Rendered as collapsible block with filename header
- Included in LLM message as formatted context block

**Size limit:** 100KB per file. Show warning if exceeded.

### Diff Preview & Accept/Reject

**Approach:** When agent's FileWrite/FileEdit tool is about to execute, intercept and show diff preview in Monaco editor. User can accept/reject per hunk. Only accepted hunks are written to disk.

**Key patterns:**
- Monaco decorations API supports inline diff rendering (green/red backgrounds)
- ToolCard already shows file edit previews — enhance with accept/reject controls
- FileWrite/FileEdit already have the before/after content available

**Implementation strategy:**
1. Add `pendingDiffs[]` to a new diff-store or chat-store
2. When tool_use event for FileWrite/FileEdit arrives, add to pendingDiffs
3. Show diff overlay in Monaco with hunk-level decorations
4. Toolbar with Accept All / Reject All
5. Per-hunk Accept/Reject buttons as Monaco gutter decorations or overlaid
6. On accept: apply changes to disk + update editor
7. On reject: discard changes, remove decoration

**Diff computation:**
- Use `diff` npm package or compute line-level diff manually
- Split into hunks (contiguous changed regions with context)
- Each hunk gets Accept/Reject buttons

**Monaco decorations API:**
```typescript
// Red for deletions
{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'diff-deleted' }}
// Green for additions
{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'diff-added' }}
```

## Dependencies

- **Phase 6 (SessionStore):** Required for session listing/loading
- **Phase 4 (ChatPanel, ToolCard):** Extended with tabs, mentions, diffs
- **cmdk:** Already installed (Phase 6)

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Monaco diff rendering performance on large files | Limit diff preview to files < 5000 lines |
| Many sessions slow tab bar | Virtual scrolling for tab bar (>20 sessions) |
| @-mention picker file count | Depth-limited listing + fuzzy search |
| Diff state across tool calls | Clear pending diffs after each agent turn |

## Validation Architecture

### Must-Have Verifications
1. Tab creation/switching preserves state
2. Agent runs only on active session
3. @-mention picker appears on "@" with fuzzy search
4. File content injected into message and LLM context
5. Diff preview shows red/green in Monaco
6. Per-hunk accept/reject works correctly
7. Rejected hunks not written to disk
