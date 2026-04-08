# Architecture Patterns: v1.2 Feature Integration

**Domain:** AI Coding IDE -- 10 new features integrated into existing wzxClaw v1.0 architecture
**Researched:** 2026-04-07
**Confidence:** HIGH (based on direct codebase analysis of all existing source files)

## Recommended Architecture

The v1.2 features layer onto the existing Main/Renderer split without restructuring. The existing architecture is clean: AgentLoop yields events, IPC forwards them, Zustand stores consume them. All 10 features fit this pattern -- each adds new components, IPC channels, and store slices without modifying the core loop architecture.

The key constraint: AgentLoop.run() is the single hot path. New features must either plug into the existing event stream (new AgentEvent types) or run as parallel subsystems (indexing, session persistence) that don't block the agent loop.

```
EXISTING (v1.0):
  Main: [LLMGateway] -> [AgentLoop] -> [ToolRegistry] -> [PermissionManager]
  IPC:  [agent:send_message] / [stream:*] / [file:*] / [workspace:*] / [settings:*]
  Renderer: [IDELayout] -> [Sidebar + Editor + ChatPanel]
  Stores: chat-store, tab-store, settings-store, workspace-store

NEW (v1.2) -- overlay:
  Main:  [TokenCounter] [ContextManager] [SessionStore] [PtyManager] [IndexManager]
  IPC:   + [session:*] + [terminal:*] + [context:*] + [index:*] + [command:*]
  Renderer: + [CommandPalette] + [TerminalPanel] + [DiffView] + [SessionTabs]
  Stores:  + session-store, command-store, terminal-store, diff-store, task-store
```

### Full Architecture Diagram (v1.2)

```
+-------------------------------------------------------------------+
|                    Electron Main Process (Node.js)                  |
|                                                                     |
|  +-------------+  +--------------+  +---------------------------+  |
|  | LLM Gateway |  | Agent Loop   |  | NEW: Context Manager      |  |
|  | (existing)  |<-| (existing,   |<-|  - TokenCounter           |  |
|  |             |  |  modified)   |  |  - AutoCompact            |  |
|  +-------------+  +-------+------+  |  - TokenBudget            |  |
|                    |               +---------------------------+   |
|  +-------------+  |               +---------------------------+   |
|  | Tool System |<-+               | NEW: Session Store         |  |
|  | (existing + |  |               |  - JSONL read/write        |  |
|  |  NEW tools) |  |               |  - Conversation serialize   |  |
|  +-------------+  |               +---------------------------+   |
|                    |               +---------------------------+   |
|  +-------------+  |               | NEW: Pty Manager           |  |
|  | Permission  |<-+               |  - node-pty instances      |  |
|  | Manager     |                  |  - shell session lifecycle |  |
|  | (existing)  |                  +---------------------------+   |
|  +-------------+                  +---------------------------+   |
|                                    | NEW: Index Manager         |  |
|                                    |  - File chunking           |  |
|                                    |  - Embedding generation    |  |
|                                    |  - sqlite-vec storage      |  |
|                                    +---------------------------+   |
|                                                                    |
|  +--------------------------------------------------------------+ |
|  | IPC Handlers (existing + NEW channels)                        | |
|  +--------------------------------------------------------------+ |
+-------------------------------------------------------------------+
         |  IPC Bridge (contextBridge)
+-------------------------------------------------------------------+
|                    Renderer Process (Chromium + React)               |
|                                                                     |
|  +--------------------------------------------------------------+ |
|  | IDELayout (existing, modified)                                | |
|  |  [Sidebar] | [TabBar + Editor + DIFF VIEW] | [Chat Area]     | |
|  |             |                              |  [Session Tabs] | |
|  |             |                              |  [ChatPanel]    | |
|  |             |  [TERMINAL PANEL (bottom)]                    | |
|  +--------------------------------------------------------------+ |
|                                                                     |
|  +--------------------+  +-------------------+  +----------------+ |
|  | CommandPalette     |  | NEW: DiffStore    |  | NEW: TaskStore | |
|  | (Ctrl+Shift+P)     |  |  - hunks[]        |  |  - tasks[]      | |
|  |  - cmdk overlay    |  |  - accept/reject  |  |  - dependencies | |
|  +--------------------+  +-------------------+  +----------------+ |
|                                                                     |
|  +--------------------------------------------------------------+ |
|  | Stores (existing, extended)                                   | |
|  | chat-store  (MODIFIED: multi-session, @-mention, token count) | |
|  | tab-store   (MODIFIED: diff integration)                      | |
|  | session-store (NEW)  terminal-store (NEW)  task-store (NEW)   | |
|  +--------------------------------------------------------------+ |
+-------------------------------------------------------------------+
```

### Component Boundaries

| Component | Location | Status | Responsibility | Communicates With |
|-----------|----------|--------|---------------|-------------------|
| **ContextManager** | `main/agent/context-manager.ts` | NEW | Token counting, auto-compact, token budget, context window optimization | AgentLoop, LLMGateway |
| **TokenCounter** | `main/agent/token-counter.ts` | NEW | Count tokens per message, per model. tiktoken for OpenAI, estimation for others | ContextManager |
| **SessionStore** | `main/session/session-store.ts` | NEW | JSONL persistence, conversation save/restore, session list | IPC handlers |
| **PtyManager** | `main/terminal/pty-manager.ts` | NEW | node-pty lifecycle, shell spawn/destroy, data piping | IPC handlers, BashTool |
| **IndexManager** | `main/indexing/index-manager.ts` | NEW | File chunking, embedding API calls, sqlite-vec storage, semantic search | IPC handlers, ToolRegistry |
| **DiffCalculator** | `main/tools/diff-calculator.ts` | NEW | Compute unified diff hunks from old/new file content | AgentLoop (via tool events) |
| **CommandRegistry** | `main/command/command-registry.ts` | NEW | Register commands, execute by ID, forward results | IPC handlers |
| **TaskManager** | `main/agent/task-manager.ts` | NEW | Task CRUD, dependency tracking, status management | AgentLoop, IPC handlers |
| **WebSearchTool** | `main/tools/web-search.ts` | NEW | Web search via API, result formatting | ToolRegistry |
| **WebFetchTool** | `main/tools/web-fetch.ts` | NEW | Fetch URL content, extract text | ToolRegistry |
| **NotebookEditTool** | `main/tools/notebook-edit.ts` | NEW | Edit Jupyter notebook cells | ToolRegistry |
| **SymbolNavigationTool** | `main/tools/symbol-nav.ts` | NEW | LSP-style symbol search in workspace | ToolRegistry |
| **CommandPalette** | `renderer/components/command/CommandPalette.tsx` | NEW | Ctrl+Shift+P overlay, cmdk-based, fuzzy filter | command-store |
| **TerminalPanel** | `renderer/components/terminal/TerminalPanel.tsx` | NEW | xterm.js terminal, resize, multiple instances | terminal-store |
| **InlineDiffView** | `renderer/components/diff/InlineDiffView.tsx` | NEW | Red/green diff hunks in Monaco, accept/reject per hunk | diff-store |
| **SessionTabs** | `renderer/components/chat/SessionTabs.tsx` | NEW | Tab bar above chat for multiple sessions | session-store |
| **MentionInput** | `renderer/components/chat/MentionInput.tsx` | NEW | @-trigger autocomplete for files/folders | chat-store, workspace-store |
| **TokenIndicator** | `renderer/components/chat/TokenIndicator.tsx` | NEW | Token count display in chat header | chat-store |
| **ChatPanel** | `renderer/components/chat/ChatPanel.tsx` | MODIFIED | Add MentionInput, TokenIndicator, SessionTabs integration | Same + new stores |
| **IDELayout** | `renderer/components/ide/IDELayout.tsx` | MODIFIED | Add TerminalPanel region, CommandPalette overlay | Same + new stores |
| **AgentLoop** | `main/agent/agent-loop.ts` | MODIFIED | Plug in ContextManager, yield diff events, task events | ContextManager, DiffCalculator, TaskManager |
| **chat-store** | `renderer/stores/chat-store.ts` | MODIFIED | Add @-mention context to messages, token count tracking | MentionInput, TokenIndicator |
| **ipc-channels.ts** | `shared/ipc-channels.ts` | MODIFIED | Add new channel definitions for all 10 features | All |
| **preload/index.ts** | `preload/index.ts` | MODIFIED | Expose new IPC methods for all 10 features | All renderer stores |

## New IPC Channels

These channels must be added to `shared/ipc-channels.ts` and `preload/index.ts`.

### Session Persistence Channels

```typescript
// Request/Response (renderer -> main)
'session:list':        RequestPayloads  -> SessionSummary[]
'session:load':        { sessionId }    -> Conversation | null
'session:save':        { session }      -> void
'session:delete':      { sessionId }    -> void
'session:rename':      { sessionId, title } -> void

// Stream (main -> renderer)
'session:autosaved':   { sessionId, timestamp }
```

### Terminal Channels

```typescript
// Request/Response (renderer -> main)
'terminal:create':     { shellType? }   -> { terminalId }
'terminal:write':      { terminalId, data } -> void
'terminal:resize':     { terminalId, cols, rows } -> void
'terminal:kill':       { terminalId }   -> void

// Stream (main -> renderer)
'terminal:data':       { terminalId, data }     // stdout/stderr from pty
'terminal:exit':       { terminalId, exitCode }
```

### Context Management Channels

```typescript
// Request/Response (renderer -> main)
'context:token_count': { messages }     -> { totalTokens, breakdown }

// Stream (main -> renderer)
'context:compacted':   { sessionId, tokensBefore, tokensAfter }
'context:budget':      { used, total, percentage }
```

### Command Palette Channels

```typescript
// Request/Response (renderer -> main)
'command:execute':     { commandId, args? } -> unknown
'command:list':        void            -> CommandItem[]
```

### Indexing Channels

```typescript
// Request/Response (renderer -> main)
'index:build':         { rootPath }    -> { indexedFiles, chunks }
'index:search':        { query, topK? } -> SearchResult[]
'index:status':        void            -> { isIndexing, totalFiles, totalChunks }

// Stream (main -> renderer)
'index:progress':      { filesProcessed, totalFiles }
```

### Task Channels

```typescript
// Bidirectional
'task:create':         { title, description?, parentId? } -> Task
'task:update':         { taskId, status } -> void
'task:list':           void            -> Task[]
'task:delete':         { taskId }      -> void
```

### Diff Channels

```typescript
// Stream (main -> renderer) -- during agent tool execution
'stream:diff_preview': { toolCallId, filePath, hunks[] }

// Request/Response (renderer -> main)
'diff:accept_hunk':    { toolCallId, hunkIndex } -> void
'diff:reject_hunk':    { toolCallId, hunkIndex } -> void
'diff:accept_all':     { toolCallId }   -> void
'diff:reject_all':     { toolCallId }   -> void
```

### Modified Existing Channels

```typescript
// agent:send_message now accepts optional @-mention context
'agent:send_message': {
  conversationId: string
  content: string
  attachments?: Attachment[]  // NEW: @-mention file/folder references
}

interface Attachment {
  type: 'file' | 'folder' | 'symbol'
  path: string
  content?: string  // populated by main process
}
```

## New Store Slices

### session-store.ts (NEW)

```typescript
interface SessionState {
  sessions: SessionSummary[]       // id, title, updatedAt, messageCount
  activeSessionId: string | null
  isLoading: boolean
}
interface SessionActions {
  loadSessionList: () => Promise<void>
  createSession: () => string       // returns new session ID
  switchSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
}
```

The session-store manages multiple conversations. When switching sessions, it must:
1. Save current chat-store messages to main process via IPC
2. Clear chat-store
3. Load new session's messages from main process
4. Update chat-store with loaded messages
5. Trigger tab-store refresh if needed

### terminal-store.ts (NEW)

```typescript
interface TerminalState {
  terminals: TerminalInstance[]     // { id, title, isActive }
  activeTerminalId: string | null
  isVisible: boolean               // panel open/closed
}
interface TerminalActions {
  createTerminal: () => Promise<void>
  writeData: (id: string, data: string) => void
  resizeTerminal: (id: string, cols: number, rows: number) => void
  killTerminal: (id: string) => void
  setActiveTerminal: (id: string) => void
  toggleVisibility: () => void
}
```

### diff-store.ts (NEW)

```typescript
interface DiffState {
  pendingDiffs: Map<string, DiffInfo>  // keyed by toolCallId
}
interface DiffInfo {
  toolCallId: string
  filePath: string
  hunks: DiffHunk[]
  status: 'pending' | 'partial' | 'applied' | 'rejected'
}
interface DiffActions {
  addDiff: (toolCallId: string, diff: DiffInfo) => void
  acceptHunk: (toolCallId: string, hunkIndex: number) => void
  rejectHunk: (toolCallId: string, hunkIndex: number) => void
  acceptAll: (toolCallId: string) => void
  rejectAll: (toolCallId: string) => void
}
```

### command-store.ts (NEW)

```typescript
interface CommandState {
  isOpen: boolean
  commands: CommandItem[]
}
interface CommandActions {
  openPalette: () => void
  closePalette: () => void
  executeCommand: (id: string) => Promise<void>
  loadCommands: () => Promise<void>
}
```

### task-store.ts (NEW)

```typescript
interface TaskState {
  tasks: Task[]
  activeTaskId: string | null
}
interface TaskActions {
  createTask: (title: string, description?: string) => Promise<void>
  updateTaskStatus: (id: string, status: TaskStatus) => Promise<void>
  deleteTask: (id: string) => Promise<void>
}
```

### chat-store.ts (MODIFICATIONS)

The existing chat-store needs these additions:

```typescript
// New state fields
tokenCount: number              // current conversation token count
contextBudget: number           // model's context window size
attachments: Attachment[]       // @-mention files for current message

// New actions
addAttachment: (attachment: Attachment) => void
removeAttachment: (path: string) => void
clearAttachments: () => void
updateTokenCount: (count: number) => void
```

## Data Flows for New Features

### Feature 1: Context Management

```
AgentLoop.run() flow (MODIFIED):

1. Before each LLM call:
   contextManager.countTokens(messages) -> tokenCount
   if tokenCount > contextWindow - SAFETY_BUFFER:
     contextManager.autoCompact(messages, gateway) -> compactedMessages
     yield { type: 'agent:context_compacted', tokensBefore, tokensAfter }
   contextManager.enforceBudget(messages, totalTokens) -> preparedMessages
   yield { type: 'agent:context_budget', used, total }

2. After each LLM response:
   Accumulate usage.inputTokens + usage.outputTokens into budgetTracker
   if budgetTracker.shouldStop():
     yield { type: 'agent:done', reason: 'budget_exhausted' }

3. Renderer updates:
   stream:context_budget -> chat-store.updateTokenCount()
   stream:context_compacted -> UI notification
```

TokenCounter lives in main process only. It uses tiktoken (WASM) for OpenAI models and character-based estimation (chars/4) for Anthropic models (no official JS tokenizer). The ContextManager wraps token counting + auto-compact + budget tracking into a single module called by AgentLoop before each LLM turn.

### Feature 2: Inline Diff Preview

```
AgentLoop.run() flow (MODIFIED):

When agent calls FileWrite or FileEdit:
1. Tool executes as normal (produces new file content)
2. NEW: DiffCalculator.compute(oldContent, newContent) -> hunks[]
3. AgentLoop yields new event type:
   yield { type: 'agent:diff_preview', toolCallId, filePath, hunks }
4. IPC forwards to renderer:
   sender.send('stream:diff_preview', { toolCallId, filePath, hunks })

Renderer flow:
1. diff-store receives diff_preview event
2. DiffView component renders inline in ChatMessage (below ToolCard)
3. User clicks accept/reject per hunk
4. Renderer -> IPC -> Main:
   ipcRenderer.invoke('diff:accept_hunk', { toolCallId, hunkIndex })
   OR
   ipcRenderer.invoke('diff:reject_hunk', { toolCallId, hunkIndex })
5. Main process applies/reverts the hunk
6. file:changed event fires to refresh editor tab
```

CRITICAL DESIGN DECISION: Diffs are applied eagerly (tool already wrote the file), and reject reverts. This is simpler than buffering writes. If the user rejects a hunk, the file is rewritten with that hunk reverted. This matches Cursor's approach.

### Feature 3: @-mention Context

```
Renderer flow:
1. User types @ in ChatPanel textarea
2. MentionInput component shows autocomplete dropdown
3. Dropdown items from workspace-store.tree (files/folders)
4. User selects a file -> chat-store.addAttachment({ type: 'file', path })
5. Selected files shown as chips above textarea

Send flow:
1. User hits Enter -> sendMessage(content, attachments)
2. chat-store -> IPC -> main: agent:send_message { content, attachments }
3. Main process:
   a. For each attachment with type 'file':
      Read file content from disk
      Prepend to user message: "[File: {path}]\n{content}\n\n"
   b. For type 'folder':
      List files + structure summary
      Prepend: "[Folder: {path}]\n{file listing}\n\n"
4. AgentLoop processes augmented message as normal
```

No new IPC channels needed -- just extend the `agent:send_message` payload with optional `attachments[]`. The main process resolves attachment content and injects it into the user message before the LLM sees it.

### Feature 4: Multi-session Management

```
Architecture:
  - session-store (renderer): manages session list, active session switching
  - SessionStore (main): handles JSONL file I/O, session CRUD

Session switching flow:
1. User clicks session tab or "New Chat" button
2. session-store.switchSession(newId):
   a. Save current session:
      chat-store.getMessages() -> IPC -> session:save { id, messages, title }
   b. Clear chat-store
   c. Load new session:
      IPC -> session:load { id } -> messages
      chat-store.loadMessages(messages)  // NEW action
3. chat-store loads messages and conversationId

Session auto-save:
  - After each agent:done event, main process appends to JSONL
  - File: %APPDATA%/wzxclaw/sessions/{conversationId}.jsonl
  - Each line: JSON { type: 'user_message'|'assistant_message'|'tool_result', ... }
```

The chat-store must be refactored to support loading arbitrary messages (currently it only appends). Add a `loadMessages(messages: ChatMessage[], conversationId: string)` action.

### Feature 5: Command Palette

```
Renderer flow:
1. Ctrl+Shift+P -> IDELayout captures keydown
2. command-store.openPalette() -> CommandPalette component renders
3. cmdk component shows searchable command list
4. Commands loaded from:
   - Static commands (defined in renderer: toggle terminal, new session, clear chat, etc.)
   - Dynamic commands from main process (via IPC command:list)
5. User selects command -> command-store.executeCommand(id)
6. If command is renderer-local: execute directly
7. If command needs main process: IPC command:execute { id, args }
```

Use cmdk (npm package) for the command palette UI. It is unstyled, fast, and handles keyboard navigation and fuzzy search. wzxClaw styles it to match the existing dark theme.

### Feature 6: Terminal Panel

```
Main process:
1. PtyManager manages node-pty instances
2. Each terminal = one node-pty process + unique ID
3. node-pty spawns shell (cmd.exe on Windows, bash on Linux/Mac)
4. PtyManager pipes pty.onData -> IPC -> renderer

Renderer:
1. TerminalPanel uses xterm.js + @xterm/addon-fit
2. xterm.js renders terminal UI
3. User input -> IPC -> main -> pty.write(data)
4. pty output -> IPC -> renderer -> xterm.write(data)

Layout integration:
  IDELayout adds a resizable bottom panel below the editor area.
  [Sidebar] | [TabBar + Editor] | [ChatPanel]
            | [TerminalPanel (collapsible bottom)]
  Use Allotment vertical split in the center pane.
```

CRITICAL: node-pty is a native module. It requires `electron-rebuild` or `@electron/rebuild` to compile for Electron's Node.js version. This must be in the build toolchain. xterm.js runs entirely in the renderer; only the PTY process lives in main.

### Feature 7: More Tools

Each new tool follows the existing Tool interface:

```typescript
// main/tools/web-search.ts
class WebSearchTool implements Tool {
  name = 'WebSearch'
  description = 'Search the web for information'
  requiresApproval = false  // read-only
  inputSchema = { query: string, limit?: number }
  execute(input, context) -> { output: string, isError: boolean }
}

// main/tools/web-fetch.ts
class WebFetchTool implements Tool {
  name = 'WebFetch'
  description = 'Fetch content from a URL'
  requiresApproval = false  // read-only
  inputSchema = { url: string }
  execute(input, context) -> { output: string, isError: boolean }
}

// main/tools/notebook-edit.ts
class NotebookEditTool implements Tool {
  name = 'NotebookEdit'
  description = 'Edit Jupyter notebook cells'
  requiresApproval = true   // modifies files
  inputSchema = { path: string, cellIndex: number, newSource: string }
  execute(input, context) -> { output: string, isError: boolean }
}

// main/tools/symbol-nav.ts
class SymbolNavigationTool implements Tool {
  name = 'SymbolSearch'
  description = 'Search for symbols (functions, classes, variables) in the workspace'
  requiresApproval = false  // read-only
  inputSchema = { query: string, filePattern?: string }
  execute(input, context) -> { output: string, isError: boolean }
}
```

SymbolNavigationTool will use regex-based parsing (not a full LSP server) for the MVP. It searches for function/class/variable declarations using pattern matching across workspace files.

### Feature 8: Codebase Indexing

```
Main process:
1. IndexManager watches workspace root
2. On index:build command:
   a. Walk all files (respect .gitignore patterns)
   b. Chunk files into ~200-line segments with overlap
   c. For each chunk, call embedding API (OpenAI text-embedding-3-small or local model)
   d. Store vectors in sqlite-vec database
   e. File: %APPDATA%/wzxclaw/index/{workspaceHash}.db

3. On semantic search:
   a. Embed query text
   b. Query sqlite-vec for top-K nearest vectors
   c. Return matching file chunks with file paths and line ranges

Tool integration:
  Add a SemanticSearch tool to ToolRegistry:
  name = 'SemanticSearch'
  inputSchema = { query: string, topK?: number }
  requiresApproval = false
```

Use sqlite-vec (via `sql.js` or `better-sqlite3` with sqlite-vec extension) for local vector storage. Embedding generation uses the OpenAI API (text-embedding-3-small is cheap at $0.02/1M tokens). For offline use, fall back to TF-IDF-based search.

### Feature 9: Session Persistence

Covered in Feature 4 (Multi-session). The storage format is JSONL -- one JSON object per line per message. This format is append-only (fast writes), supports streaming reads (load recent N messages without parsing entire file), and is human-readable.

```
File: %APPDATA%/wzxclaw/sessions/{conversationId}.jsonl

{"type":"user","content":"Read main.ts","timestamp":1712467200000}
{"type":"assistant","content":"I'll read that file.","toolCalls":[{"id":"tc_1","name":"FileRead","input":{"path":"main.ts"}}],"timestamp":1712467201000}
{"type":"tool_result","toolCallId":"tc_1","content":"import {app}...","isError":false,"timestamp":1712467202000}
```

Session metadata (title, updatedAt, messageCount) stored in a separate index file:
```
File: %APPDATA%/wzxclaw/sessions/index.json
[{ "id": "...", "title": "Auto-generated from first message", "updatedAt": 1712467200000, "messageCount": 5 }]
```

### Feature 10: Task/Plan System

```
Main process:
1. TaskManager maintains task tree in memory
2. Tasks stored as part of session JSONL (appended as task events)
3. Task states: pending -> in_progress -> completed | failed

Integration with AgentLoop:
1. User creates task via chat: "Create a task to implement auth"
2. AgentLoop recognizes task creation intent
3. TaskManager.createTask(title, description) -> task
4. Yield event: { type: 'agent:task_created', task }
5. Renderer displays task in task panel/sidebar
6. Agent can update task status as it works:
   TaskManager.updateTaskStatus(taskId, 'in_progress')
   TaskManager.updateTaskStatus(taskId, 'completed')
```

This is the lightest implementation -- tasks are stored in session data, displayed in the chat sidebar, and managed by the agent during execution. No separate database needed.

## Patterns to Follow

### Pattern 1: Feature-as-Subsystem
**What:** Each new feature is a self-contained subsystem with its own main-process module, IPC channels, renderer store, and UI components.
**When:** All 10 features.
**Why:** Prevents coupling between features. Each can be built, tested, and enabled/disabled independently. The existing AgentLoop is not a monolith -- it calls into subsystems (ContextManager, TaskManager) via clean interfaces.

### Pattern 2: Extend AgentEvent Union
**What:** New features that need to surface during agent execution add new variants to the AgentEvent union type.
**When:** Context management, diff preview, task system.
**Why:** The async generator pattern (AgentLoop.run()) already handles this. Just add new event types and handle them in the IPC forwarding layer.

```typescript
// Add to AgentEvent union in main/agent/types.ts:
| AgentDiffPreviewEvent
| AgentContextCompactedEvent
| AgentTaskCreatedEvent
| AgentTaskUpdatedEvent
| AgentTokenBudgetEvent
```

### Pattern 3: Dual-Layer Store (Main Persistence + Renderer UI)
**What:** Session persistence uses a main-process store (file I/O) and a renderer Zustand store (UI state). The renderer store is a projection of the main store.
**When:** Session persistence, terminal, indexing.
**Why:** Main process owns the data (file system, PTY, database). Renderer owns the UI. The IPC bridge keeps them in sync without sharing mutable state.

### Pattern 4: Tool Registration Extension
**What:** New tools register with the existing ToolRegistry via the same `register()` method.
**When:** WebSearch, WebFetch, SymbolNavigation, NotebookEdit, SemanticSearch.
**Why:** Zero architectural change. The agent loop, permission system, and IPC bridge already handle arbitrary tools.

```typescript
// In main/index.ts or a new tools setup module:
registry.register(new WebSearchTool())
registry.register(new WebFetchTool())
registry.register(new SymbolNavigationTool())
registry.register(new NotebookEditTool())
registry.register(new SemanticSearchTool(indexManager))
```

### Pattern 5: Panel Region Pattern
**What:** IDELayout uses nested Allotment components to create resizable panel regions.
**When:** Terminal panel (bottom), diff view (inline in editor).
**Why:** Consistent with existing layout approach. No new layout library needed.

```tsx
// IDELayout center pane modification:
<Allotment.Pane>
  <Allotment vertical defaultSizes={[400, 150]}>
    <Allotment.Pane>
      {hasTabs && <TabBar />}
      {hasTabs ? <EditorPanel /> : <WelcomeScreen />}
    </Allotment.Pane>
    <Allotment.Pane minSize={0} maxSize={400}>
      {showTerminal && <TerminalPanel />}
    </Allotment.Pane>
  </Allotment>
</Allotment.Pane>
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Token Counting in Renderer
**What:** Running tiktoken or token estimation in the renderer process.
**Why bad:** tiktoken WASM binary is ~1MB. Running it on every keystroke would block the UI thread. Token counting requires the full message history which may be large.
**Instead:** Token counting happens exclusively in main process (ContextManager). Renderer receives token counts via IPC events.

### Anti-Pattern 2: PTY in Renderer
**What:** Creating node-pty instances in the renderer process.
**Why bad:** node-pty is a native Node.js module. It cannot run in the renderer (no Node.js access due to context isolation).
**Instead:** All PTY instances live in main process. xterm.js (renderer) is purely a terminal emulator UI. Data flows through IPC: keystrokes -> main -> pty -> IPC -> renderer -> xterm.write().

### Anti-Pattern 3: Storing Full Message History in Zustand
**What:** Loading all messages from all sessions into the Zustand store simultaneously.
**Why bad:** Long conversations (100+ messages with file contents) consume excessive renderer memory. React re-renders become expensive.
**Instead:** Only load messages for the active session. When switching sessions, save current and load new. Pagination for very long conversations (load last 50 messages, load more on scroll).

### Anti-Pattern 4: Synchronous Index Building
**What:** Blocking the main process while indexing the entire workspace.
**Why bad:** Large workspaces (10K+ files) would freeze the app for minutes.
**Instead:** Index building runs in batches with yields. Progress reported via IPC. User can cancel. Background indexing uses idle CPU time.

### Anti-Pattern 5: Diff Preview as Separate Window
**What:** Opening diff preview in a new Electron BrowserWindow.
**Why bad:** Breaks the IDE flow. User has to manage another window. Cursor and VS Code show diffs inline.
**Instead:** Inline diff view rendered inside the ChatPanel as part of the ToolCard, or as a Monaco diff editor replacing the editor pane temporarily.

### Anti-Pattern 6: Requiring Full LSP for Symbol Navigation
**What:** Embedding a full Language Server Protocol implementation.
**Why bad:** Massive complexity. Requires per-language servers. Configuration nightmare for a personal tool.
**Instead:** Regex-based symbol extraction for MVP. Parse function/class/variable declarations using language-aware patterns. Good enough for 80% of navigation needs.

## Suggested Build Order (Dependency-Based)

The build order is determined by feature dependencies. Features that other features depend on come first.

### Wave 1: Foundation Features (no dependencies on other new features)

**Phase 6A: Context Management** (Feature 1)
- **Why first:** Every subsequent feature benefits from token awareness. Long conversations with many tool calls will hit context limits without this.
- **New components:**
  - `main/agent/token-counter.ts` -- tiktoken integration
  - `main/agent/context-manager.ts` -- auto-compact, budget tracking
- **Modified components:**
  - `main/agent/agent-loop.ts` -- call ContextManager before each LLM turn
  - `shared/types.ts` -- add context-related AgentEvent types
  - `shared/ipc-channels.ts` -- add context:* channels
  - `preload/index.ts` -- add context IPC methods
  - `renderer/stores/chat-store.ts` -- add tokenCount state, context budget listener
  - `renderer/components/chat/TokenIndicator.tsx` -- new component
- **Dependencies:** tiktoken npm package
- **Estimated complexity:** MEDIUM

**Phase 6B: Session Persistence** (Feature 9)
- **Why first:** Multi-session management (Feature 4) depends on persistence being available. Also, users lose conversations on app restart without this.
- **New components:**
  - `main/session/session-store.ts` -- JSONL read/write
  - `main/session/types.ts` -- session serialization types
- **Modified components:**
  - `main/agent/agent-loop.ts` -- yield events for session logging
  - `main/ipc-handlers.ts` -- register session:* handlers
  - `shared/ipc-channels.ts` -- add session:* channels
  - `preload/index.ts` -- add session IPC methods
  - `renderer/stores/chat-store.ts` -- add loadMessages action
- **Dependencies:** None new (fs already available in main)
- **Estimated complexity:** MEDIUM

**Phase 6C: Command Palette** (Feature 5)
- **Why here:** Low complexity, no dependencies on other new features, provides a framework that other features register commands into. Also the highest UX impact for lowest effort.
- **New components:**
  - `renderer/components/command/CommandPalette.tsx` -- cmdk overlay
  - `renderer/stores/command-store.ts` -- command state + execution
  - `main/command/command-registry.ts` -- server-side commands
- **Modified components:**
  - `renderer/components/ide/IDELayout.tsx` -- add Ctrl+Shift+P handler, mount CommandPalette
  - `shared/ipc-channels.ts` -- add command:* channels
  - `preload/index.ts` -- add command IPC methods
- **Dependencies:** cmdk npm package
- **Estimated complexity:** LOW

### Wave 2: Core Interaction Features (depend on Wave 1)

**Phase 7A: Multi-session Management** (Feature 4)
- **Depends on:** Session Persistence (6B)
- **New components:**
  - `renderer/components/chat/SessionTabs.tsx` -- tab bar for sessions
- **Modified components:**
  - `renderer/stores/chat-store.ts` -- already has loadMessages from 6B
  - `renderer/stores/session-store.ts` -- new store for session list UI state
  - `renderer/components/chat/ChatPanel.tsx` -- integrate SessionTabs
- **Dependencies:** Session Persistence (6B)
- **Estimated complexity:** MEDIUM

**Phase 7B: @-mention Context** (Feature 3)
- **Depends on:** None strictly, but benefits from token awareness (6A) to warn about context overflow
- **New components:**
  - `renderer/components/chat/MentionInput.tsx` -- autocomplete dropdown
- **Modified components:**
  - `renderer/stores/chat-store.ts` -- add attachments[] state
  - `shared/types.ts` -- add Attachment type
  - `shared/ipc-channels.ts` -- extend agent:send_message payload
  - `renderer/components/chat/ChatPanel.tsx` -- integrate MentionInput
- **Dependencies:** workspace-store.tree for file list
- **Estimated complexity:** MEDIUM

**Phase 7C: Inline Diff Preview** (Feature 2)
- **Depends on:** None strictly, but uses token counting (6A) for budget awareness
- **New components:**
  - `main/tools/diff-calculator.ts` -- compute unified diff hunks
  - `renderer/components/diff/InlineDiffView.tsx` -- diff rendering in chat
  - `renderer/stores/diff-store.ts` -- pending diff state
- **Modified components:**
  - `main/agent/agent-loop.ts` -- yield diff_preview event after FileWrite/FileEdit
  - `main/agent/types.ts` -- add AgentDiffPreviewEvent
  - `shared/ipc-channels.ts` -- add diff:* channels
  - `preload/index.ts` -- add diff IPC methods
  - `renderer/components/chat/ToolCard.tsx` -- embed InlineDiffView
- **Dependencies:** diff npm package (or compute manually)
- **Estimated complexity:** HIGH

### Wave 3: Advanced Features (depend on Wave 1+2)

**Phase 8A: Terminal Panel** (Feature 6)
- **Depends on:** Command Palette (6C) for terminal-related commands
- **New components:**
  - `main/terminal/pty-manager.ts` -- node-pty lifecycle
  - `renderer/components/terminal/TerminalPanel.tsx` -- xterm.js wrapper
  - `renderer/stores/terminal-store.ts` -- terminal UI state
- **Modified components:**
  - `renderer/components/ide/IDELayout.tsx` -- add terminal panel region
  - `shared/ipc-channels.ts` -- add terminal:* channels
  - `preload/index.ts` -- add terminal IPC methods
- **Dependencies:** node-pty, @xterm/xterm, @xterm/addon-fit, electron-rebuild
- **Estimated complexity:** HIGH (native module compilation)

**Phase 8B: More Tools** (Feature 7)
- **Depends on:** None strictly
- **New components:**
  - `main/tools/web-search.ts` -- WebSearchTool
  - `main/tools/web-fetch.ts` -- WebFetchTool
  - `main/tools/symbol-nav.ts` -- SymbolNavigationTool
  - `main/tools/notebook-edit.ts` -- NotebookEditTool
- **Modified components:**
  - `main/tools/tool-registry.ts` -- register new tools in factory
- **Dependencies:** Each tool may need its own npm package (web search API client, etc.)
- **Estimated complexity:** MEDIUM

**Phase 8C: Task/Plan System** (Feature 10)
- **Depends on:** Session Persistence (6B) for task storage
- **New components:**
  - `main/agent/task-manager.ts` -- task CRUD + dependency tracking
  - `renderer/stores/task-store.ts` -- task UI state
  - `renderer/components/task/TaskPanel.tsx` -- task list in sidebar
- **Modified components:**
  - `main/agent/agent-loop.ts` -- yield task events
  - `main/agent/types.ts` -- add task AgentEvent types
  - `shared/ipc-channels.ts` -- add task:* channels
- **Dependencies:** Session Persistence (6B)
- **Estimated complexity:** MEDIUM

### Wave 4: Heavy Features (largest scope, can be deferred)

**Phase 9: Codebase Indexing** (Feature 8)
- **Depends on:** Context Management (6A) for token awareness, embedding API key in settings
- **New components:**
  - `main/indexing/index-manager.ts` -- file chunking, embedding, search
  - `main/indexing/embedding-client.ts` -- embedding API calls
  - `main/indexing/vector-store.ts` -- sqlite-vec wrapper
  - `main/tools/semantic-search.ts` -- SemanticSearch tool
- **Modified components:**
  - `main/tools/tool-registry.ts` -- register SemanticSearch tool
  - `shared/ipc-channels.ts` -- add index:* channels
  - `shared/constants.ts` -- add indexing constants
- **Dependencies:** sqlite-vec (or better-sqlite3 + sqlite-vec extension), embedding API access
- **Estimated complexity:** HIGH

### Dependency Graph

```
Wave 1 (foundation):
  6A: Context Management ----+
  6B: Session Persistence ----|---+
  6C: Command Palette --------+   |
                                  |
Wave 2 (core interaction):       |
  7A: Multi-session (needs 6B) --+
  7B: @-mention (standalone) ----+
  7C: Inline Diff (standalone) --+
                                  |
Wave 3 (advanced):               |
  8A: Terminal (needs 6C) -------+
  8B: More Tools (standalone) ---+
  8C: Task/Plan (needs 6B) ------+
                                  |
Wave 4 (heavy):                  |
  9:  Codebase Index (needs 6A) -+
```

## Scalability Considerations

| Concern | At 10 Sessions | At 100 Sessions | At 1000+ Sessions |
|---------|---------------|-----------------|-------------------|
| **Session Storage** | JSONL files, index.json in memory | Index-only in memory, lazy-load messages on session switch | Consider SQLite for session metadata, paginate session list |
| **Token Counting** | Count on every message send | Cache token counts per message, only recount new messages | Pre-compute and cache, batch counting |
| **Index Size** | Single workspace, <10K files | Index rebuilds on demand, incremental updates | Background reindexing, file change detection |
| **Terminal Instances** | 1-3 terminals | Cap at ~5 terminals, lazy-destroy inactive ones | Terminal session persistence (save/restore shell state) |
| **Diff Previews** | 1-2 pending diffs | Auto-dismiss applied diffs, max 5 pending | Diff cleanup on session switch |

## File Structure Additions

```
src/
  main/
    agent/
      context-manager.ts          # NEW: token budget + auto-compact
      token-counter.ts            # NEW: tiktoken + estimation
      task-manager.ts             # NEW: task CRUD
      agent-loop.ts               # MODIFIED: plug in context manager, diff, tasks
      types.ts                    # MODIFIED: new event types
    session/
      session-store.ts            # NEW: JSONL persistence
      types.ts                    # NEW: session serialization types
    terminal/
      pty-manager.ts              # NEW: node-pty lifecycle
      types.ts                    # NEW: terminal types
    indexing/
      index-manager.ts            # NEW: file chunking + embedding
      embedding-client.ts         # NEW: embedding API calls
      vector-store.ts             # NEW: sqlite-vec wrapper
    tools/
      web-search.ts               # NEW
      web-fetch.ts                # NEW
      symbol-nav.ts               # NEW
      notebook-edit.ts            # NEW
      semantic-search.ts          # NEW
      diff-calculator.ts          # NEW: unified diff computation
      tool-registry.ts            # MODIFIED: register new tools
    command/
      command-registry.ts         # NEW: command definitions
    ipc-handlers.ts               # MODIFIED: register all new channels

  shared/
    types.ts                      # MODIFIED: Attachment, Diff, Task, Session types
    ipc-channels.ts               # MODIFIED: all new channel definitions
    constants.ts                  # MODIFIED: new constants (SAFETY_BUFFER, etc.)

  preload/
    index.ts                      # MODIFIED: expose all new IPC methods

  renderer/
    components/
      chat/
        ChatPanel.tsx             # MODIFIED: integrate SessionTabs, MentionInput, TokenIndicator
        MentionInput.tsx           # NEW: @-mention autocomplete
        SessionTabs.tsx            # NEW: session tab bar
        TokenIndicator.tsx         # NEW: token count display
      diff/
        InlineDiffView.tsx         # NEW: diff hunk rendering
      terminal/
        TerminalPanel.tsx          # NEW: xterm.js wrapper
      command/
        CommandPalette.tsx         # NEW: cmdk overlay
      task/
        TaskPanel.tsx              # NEW: task list
    stores/
      chat-store.ts               # MODIFIED: attachments, loadMessages, tokenCount
      session-store.ts            # NEW: session list UI state
      terminal-store.ts           # NEW: terminal instances UI state
      diff-store.ts               # NEW: pending diffs
      command-store.ts            # NEW: command palette state
      task-store.ts               # NEW: task UI state
```

## Sources

- Direct codebase analysis: All existing source files in `E:/ai/wzxClaw/src/` -- HIGH confidence
- xterm.js + node-pty integration: [xtermjs/xterm.js GitHub](https://github.com/xtermjs/xterm.js/), [Stack Overflow integration guide](https://stackoverflow.com/questions/63390143/how-do-i-connect-xterm-jsin-electron-to-a-real-working-command-prompt), [@xterm/addon-fit npm](https://www.npmjs.com/package/@xterm/addon-fit) -- HIGH confidence
- Token counting: [tiktoken npm](https://www.npmjs.com/package/tiktoken), [OpenAI tiktoken repo](https://github.com/openai/tiktoken) -- HIGH confidence
- Command palette: [cmdk GitHub](https://github.com/dip/cmdk) -- HIGH confidence
- Vector search: [sqlite-vec GitHub](https://github.com/asg017/sqlite-vec), [Vector search in multiple languages](https://alexgarcia.xyz/blog/2024/sql-vector-search-languages/index.html) -- HIGH confidence
- Claude Code source reference at `E:\ai\claude-code\` for context management patterns -- HIGH confidence
