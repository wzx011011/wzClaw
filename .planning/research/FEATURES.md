# Feature Landscape: wzxClaw v1.2

**Domain:** AI-powered desktop IDE (Cursor/Claude Code class)
**Researched:** 2026-04-07
**Scope:** 10 NEW features for v1.2 milestone (existing features already built in v1.0)

---

## Context

This document covers ONLY the 10 new features planned for v1.2. The existing v1.0 features (LLM Gateway, Agent Loop, 6 Tools, Monaco Editor, Chat Panel, Settings, NSIS installer) are assumed complete. For the original v1.0 feature landscape, see git history.

---

## Table Stakes

Features users expect in any AI IDE released in 2026. Missing these makes wzxClaw feel incomplete compared to Cursor/Claude Code/Windsurf.

| # | Feature | Why Expected | Complexity | Priority | Notes |
|---|---------|--------------|------------|----------|-------|
| 1 | **Context Management** | Every AI IDE must manage token budgets. Without it, conversations crash at context limits. Cursor shows a visual context bar. Claude Code auto-compacts at 33K buffer. Non-negotiable. | High | P0 | Three-tier approach: token estimation via js-tiktoken, visual usage bar, auto-compact via LLM summarization when threshold exceeded. |
| 2 | **Inline Diff Preview** | Cursor's signature feature. When AI edits code, red/green diffs with per-hunk accept/reject is the baseline UX. Without it, AI silently overwrites files. | High | P0 | Monaco has built-in DiffEditor (`renderSideBySide: false`). Alternative: decorations API for inline colored lines (what Cursor does). Key decision: overlay vs. DiffEditor. |
| 3 | **Terminal Panel** | AI agents must run commands. Cursor's Agent runs terminal commands autonomously. Without an embedded terminal, AI cannot execute builds, tests, git. | High | P0 | xterm.js + node-pty in Electron. VS Code, Cursor, Hyper all use this stack. IPC bridge: renderer xterm <-> main PTY. |
| 4 | **Session Persistence** | If closing the app destroys all conversations, the tool is unusable for real work. | Medium | P1 | JSONL append-only files per conversation (Claude Code pattern). Load metadata on startup, full messages on tab switch. |
| 5 | **Multi-session Management** | Multiple chat tabs is table stakes. Every IDE has tabs. Users expect to work on multiple problems simultaneously. | Medium | P1 | Tab bar in Chat Panel, each tab is a separate Conversation. Auto-title from first user message. |
| 6 | **Command Palette** | Ctrl+Shift+P is VS Code muscle memory. Cursor inherits it directly. Any VS Code-class IDE without this feels broken. | Low | P1 | Modal overlay with fuzzy search. No external deps. Build with React portal + keyboard listener. Each feature registers commands. |
| 7 | **@-mention Context** | Cursor and Windsurf both support `@file`, `@folder` injection. Users expect to manually point AI at specific files. | Medium | P1 | Autocomplete dropdown on `@` key. Start with @file only (read file content, inject as message attachment). @folder (directory listing) and @code (LSP symbols) are phase 2. |

## Differentiators

Features that elevate wzxClaw beyond basic AI IDE. Not expected, but highly valued.

| # | Feature | Value Proposition | Complexity | Priority | Notes |
|---|---------|-------------------|------------|----------|-------|
| 8 | **More Tools (LSP, WebSearch, WebFetch, NotebookEdit)** | Claude Code has 20+ tools. WebSearch/WebFetch give internet access. LSP gives code navigation. NotebookEdit enables Jupyter. These make the agent significantly more capable. | Medium | P2 | LSP is highest value (8 operations: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, callHierarchy). Start with Monaco's built-in language APIs. |
| 9 | **Task/Plan System** | Claude Code's task system tracks dependencies, blocks/unblocks tasks, coordinates workflows. Power-user feature enabling structured multi-step work. | Medium | P2 | Simpler than Claude Code: task list in sidebar, status tracking (pending/in_progress/completed/cancelled), sequential dependencies. Agent creates/updates tasks via tools. |
| 10 | **Codebase Indexing** | Cursor's `@Codebase` uses vector embeddings for semantic search. Biggest differentiator over basic AI chat. Without it, AI only knows files it explicitly reads. | Very High | P3 | Cursor: Merkle tree + custom embedding model + remote vector DB. For wzxClaw: defer to future milestone. Current Grep/Glob + @-mention covers "find relevant code" for a personal tool. |

## Anti-Features

Features to explicitly NOT build in v1.2. Already listed in PROJECT.md Out of Scope, reinforced here with rationale.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Tab Completion (Inline Suggestions)** | Requires a separate low-latency inference endpoint, not the same agent loop. Massive complexity. Already Out of Scope. | Agent-driven edits via Inline Diff. |
| **Inline Edit (Select + Cmd+K)** | Requires careful selection tracking, range management, different UX flow. Already Out of Scope. | AI uses Edit tool, shown in Inline Diff. |
| **MCP Protocol** | Full external tool ecosystem. Server/client protocol is a project unto itself. Already Out of Scope. | Add tools directly to tool registry. |
| **Cross-project unified history** | Even Cursor lacks this (top community request). No value for single-project personal tool. | Per-project session persistence. |
| **Remote/cloud vector DB** | Cursor uses remote DB causing privacy concerns. wzxClaw is personal. | Local-only storage (JSONL + SQLite). |
| **Full VS Code extension API** | Requires forking VS Code, contradicting "reference + rewrite" approach. | Build native features. |
| **Parallel multi-agent** | Cursor 3 feature. Requires task queue, resource management, conflict resolution. | Single agent with sequential tool execution. Task system is for tracking, not parallel execution. |
| **Cloud sync / user accounts** | Personal tool. No server-side infrastructure needed. | Local config files only. |

---

## Feature Deep Dives

### 1. Context Management

**How it works in production AI IDEs (HIGH confidence, source-verified):**

Claude Code's architecture (verified from source code at `src/services/compact/`):

- **Token estimation**: Uses `tokenCountWithEstimation()` -- estimates rather than exact counting for speed. Buffer reduced from 45K to 33K tokens in recent versions.
- **Auto-compact trigger**: `getAutoCompactThreshold()` = `contextWindow - AUTOCOMPACT_BUFFER_TOKENS` (13K buffer). When usage exceeds threshold, auto-compact fires.
- **Three-tier compact pipeline** (tried in order):
  1. **Session Memory Compact** (`sessionMemoryCompact.ts`) -- cheapest, preserves structured memory
  2. **Reactive Compact** (`reactiveCompact.ts`) -- groups messages, strips oldest groups first
  3. **Traditional Compact** (`compact.ts`) -- sends full conversation to LLM for summarization, replaces all messages with summary
- **Micro-compact** (`microCompact.ts`): Pre-processing step that strips verbose tool outputs before traditional compact.
- **Circuit breaker**: Stops trying auto-compact after 3 consecutive failures (prevents wasting ~250K API calls/day globally).

**Implementation for wzxClaw:**
- Use `js-tiktoken` (3M+ weekly npm downloads) for token counting
- Track cumulative token count per conversation in chat-store
- Show usage bar in Chat Panel header (percentage of context window used)
- Auto-compact: when usage exceeds threshold (e.g., 80% of model context window), make a dedicated LLM call to summarize older messages, replace with summary
- Manual `/compact` command via Command Palette
- Store compacted summary as a special `SystemCompactBoundaryMessage` (follow Claude Code's pattern)

**Dependencies:** None (standalone, but Session Persistence benefits from it)

**Complexity notes:**
- Token counting is straightforward (library call per message)
- The compaction LLM call needs careful prompt engineering to preserve task context
- The circuit breaker pattern is important -- if compact fails repeatedly, stop retrying

### 2. Inline Diff Preview

**How it works in Cursor (HIGH confidence, forum-documented):**

- AI agent modifies files using Edit/Write tools
- Changes render inline with green (additions) and red (deletions) highlighting
- Users accept, reject, or undo each individual change at hunk granularity
- Setting: Cursor Settings > Agents > Applying Changes > Inline Diffs
- Known issue: Updates sometimes reset the setting or break rendering (forum reports)

**Monaco Editor approach (HIGH confidence, API-verified):**

Two viable approaches:
1. **DiffEditor component**: `@monaco-editor/react` provides `<DiffEditor>` with `renderSideBySide: false` for inline mode. Accepts `original` and `modified` string props. Simple but replaces the active editor.
2. **Decorations API**: Add colored line decorations (green/red backgrounds) to the regular editor via `editor.deltaDecorations()`. More flexible, preserves active editor, what Cursor actually does.

**Recommended for wzxClaw -- Decorations approach:**
1. When agent calls Edit tool, capture the original content before applying
2. Compute diff hunks (use `diff` npm package for line-level diffing)
3. Instead of writing to disk immediately, show hunks as decorations in Monaco editor
4. Add accept/reject buttons per hunk (gutter icons or inline buttons)
5. On accept: write to disk. On reject: revert that hunk's decorations.
6. Store pending diffs in a Zustand store (`diff-store.ts`)
7. Multiple pending diffs across files shown in a "Changes" panel

**Dependencies:** Edit tool (already built), Monaco Editor (already integrated)

**Complexity notes:**
- Computing diffs is straightforward (well-known algorithms)
- Rendering decorations in Monaco requires understanding the decorations API
- The accept/reject UX per hunk is the hard part -- need clear visual indicators and click handlers
- Race condition: if user edits file while AI diff is pending, need merge logic or force-resolve

### 3. @-mention Context Injection

**How it works in Cursor (MEDIUM-HIGH confidence, forum-documented):**

- User types `@` in chat input, triggers autocomplete dropdown
- Options: files, folders, code symbols (restricted in Cursor 2.0)
- Selected item's content injected into user message as attachment
- Cursor 2.0 removed: cross-chat context, code-level types (now file-level only)
- Security vulnerability found: prompt injection via malicious README.md parsed through @-mention

**Implementation for wzxClaw:**
- Autocomplete dropdown appears on `@` character in chat input textarea
- File list populated from workspace (via `workspace-manager.ts`)
- On selection: read file content via IPC, attach to outgoing user message
- Mark injected content with metadata (source file path, line range) so it is distinguishable from user text
- Start with `@file` only (read full file content)
- Phase 2: `@folder` (list directory contents), `@code` (requires LSP tool)

**Dependencies:** Workspace Manager (built), Chat Panel input (built)

**Security note:** Treat @-mention injected content as DATA, not instructions. Do not parse it as system prompts or tool inputs.

### 4. Multi-session Management

**How it works in Cursor (MEDIUM confidence, documented):**

- Multiple Composer/Agent tabs, each with independent conversation
- Chat history via Ctrl+Shift+L
- Tabs isolated per window (cross-window history requested by community but not implemented)
- Chat export to markdown supported
- Duplicate chats to explore alternatives

**Implementation for wzxClaw:**
- Tab bar component at top of Chat Panel
- Each tab holds a `Conversation` reference (ID pointing to persisted session)
- Operations: new tab (+), close tab (x), switch tab (click), rename (double-click)
- Active conversation state in `chat-store.ts`
- Auto-title generation: extract key words from first user message (or ask LLM for 5-word summary)
- Tab count limit: 10 concurrent tabs (prevent memory issues)

**Dependencies:** Session Persistence (tabs need conversations that survive tab close)

### 5. Command Palette

**How it works in VS Code/Cursor (HIGH confidence, well-documented):**

- Ctrl+Shift+P opens modal overlay
- Fuzzy search over registered commands
- Commands shown with keyboard shortcuts
- Categories: File, Edit, View, AI, Tools, Settings
- Escape closes the palette

**Implementation for wzxClaw:**
- React portal modal overlay (absolutely positioned, full-screen, z-index above all)
- Global keyboard listener registered at App root level
- Command registry: `Map<string, { id, label, category?, shortcut?, handler }>`
- Fuzzy filter (use `fuse.js` or simple includes-based matching)
- Initial commands:
  - New Chat, Close Chat, Switch Model, Compact Context
  - Toggle Terminal, Toggle File Tree, Toggle Sidebar
  - Settings, Open Folder, Clear History
- Each new feature (Context, Diff, Terminal, etc.) registers its own commands

**Dependencies:** None (standalone UI component)

**Complexity:** Low. This is a well-understood UI pattern. The command registry can be a simple Zustand store.

### 6. Terminal Panel

**How it works in Cursor (HIGH confidence, official docs):**

Cursor's AI can generate terminal commands with natural language. The Agent runs terminal commands as part of larger agentic tasks. The embedded terminal is a full interactive shell.

**Technical stack (HIGH confidence, industry standard):**

- **xterm.js** (`@xterm/xterm`): Terminal emulator component for the web. Used by VS Code, Hyper, and Cursor.
- **node-pty**: Pseudo-terminal bindings for Node.js. Spawns real shell processes.
- **xterm-addon-fit**: Auto-resizes terminal to container.
- **xterm-addon-web-links**: Makes URLs clickable.

**Architecture for wzxClaw:**

```
Renderer (React)                Main Process (Node.js)
+------------------+            +--------------------+
| xterm.js         |   IPC      | node-pty           |
| Terminal component| <-------> | PTY spawn (cmd.exe)|
| FitAddon         |  input/    | PTY data events    |
| WebLinksAddon    |  output    | Process management |
+------------------+            +--------------------+
```

1. Main process: `node-pty.spawn('cmd.exe', [], { cwd: workspaceRoot })`
2. IPC channels: `terminal:input`, `terminal:output`, `terminal:resize`
3. Renderer: Mount xterm.js, pipe data through preload IPC bridge
4. AI integration: Bash tool can write to PTY (visible terminal) OR use silent `child_process.exec` (background)
5. Panel layout: Bottom panel, toggle with Ctrl+` (VS Code convention)

**Critical refactoring needed**: Current `bash.ts` tool uses `child_process.exec` for all commands. For the terminal panel, the Bash tool needs dual modes:
- **PTY mode**: For user-visible commands (interactive, colored output, long-running processes)
- **Silent mode**: For agent background tasks (quick reads, non-interactive commands)

**Dependencies:** IPC channels (exist), Bash tool (exists, needs refactoring)

### 7. More Tools

**7a. LSP Tool (Highest Value)**

Claude Code's LSPTool (verified in source at `src/tools/LSPTool/LSPTool.ts`):
- 8 operations: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`
- Uses `vscode-languageserver-types` for type definitions
- Connects to LSP servers via a manager service

**Challenge for wzxClaw**: Monaco Editor does not bundle full LSP servers. Options:
1. Monaco's built-in language APIs (limited but immediate: `registerDocumentSymbolProvider`, etc.)
2. Bundle `typescript-language-server` npm package, communicate via LSP protocol over stdio
3. Shell out to system-installed language servers

**Recommendation**: Start with Monaco's built-in APIs for TypeScript/JavaScript (Monaco has built-in TS support). Add `typescript-language-server` as a bundled dependency for richer operations. The tool interface remains stable regardless.

**7b. WebSearch Tool**

Simple HTTP tool. Agent provides query, tool returns search results.
- Implementation options: SearXNG (self-hosted), Brave Search API, Google Custom Search API, or DuckDuckGo API
- For personal tool: Brave Search API (free tier: 2000 queries/month) or DuckDuckGo (unofficial but works)
- Return: array of { title, url, snippet }
- Agent reads results, decides whether to fetch full pages via WebFetch

**7c. WebFetch Tool**

Fetches URL content for agent context.
- Use Node.js `fetch()` in main process
- Convert HTML to markdown/text for cleaner context
- Add reasonable limits: max response size (1MB), timeout (30s), rate limit per domain
- Respect robots.txt for ethical scraping

**7d. NotebookEdit Tool**

Claude Code's implementation (verified in source at `src/tools/NotebookEditTool/`):
- Edit Jupyter `.ipynb` cells by cell_id
- Operations: replace, insert, delete cells
- Reads/writes raw JSON format
- Lower priority unless user works heavily with notebooks

**Dependencies:** Tool Registry and tool interface (both built in v1.0)

### 8. Codebase Indexing

**How it works in Cursor (HIGH confidence, official blog + docs):**

From Cursor's official blog and docs:
- **Merkle tree** for efficient change detection (only re-index changed files)
- **Custom embedding model** (proprietary, details not public)
- **Remote vector DB** storing embeddings + metadata (file path, start/end line numbers)
- **Chunking**: Code split into logical units (functions, classes, blocks)
- **Retrieval**: Embed query -> cosine similarity search -> top-k chunks returned
- **Scale**: Cursor handles 500K+ line codebases well; degrades more gracefully than Windsurf

**Why this is P3 / Defer to v1.3:**

This is the single most complex feature. Full Cursor-quality indexing requires:
1. An embedding model (local: `transformers.js` with small model, or API: OpenAI embeddings endpoint)
2. Vector storage (local: SQLite + vector extension, or `faiss-node`, or in-memory arrays)
3. AST-aware code chunking (split by functions/classes, not arbitrary line counts)
4. Incremental re-indexing (file watcher + content hash comparison)
5. Query pipeline (embed query -> search -> rank -> inject into context)
6. Index persistence (survive app restarts)

**For v1.2, recommend**: Enhance existing Grep/Glob tools with smarter ranking. Add a "project map" tool that generates a file tree summary with key file descriptions. This covers 80% of the "find relevant code" use case with 5% of the effort. Full vector indexing moves to v1.3.

**Dependencies (if implemented later):** chokidar file watcher (in stack), tool system

### 9. Session Persistence

**How it works in Claude Code (HIGH confidence, source-verified):**

From source and documentation:
- **Format**: JSONL (JSON Lines) -- each line is a self-contained JSON object. Ideal for append-only logs. Large files never fail to parse (one bad line does not corrupt the rest).
- **Location**: `~/.claude/projects/` (per-project), `~/.claude/history.jsonl` (global)
- **Operations**: `continue` (pick up where left off), `resume` (restore specific session by ID), `fork` (branch from a conversation point)
- **Auto-deletion**: Old sessions pruned after 30 days
- **History entries**: Users accumulate 1,000+ sessions over time

**Implementation for wzxClaw:**
- Storage path: `{workspace}/.wzxClaw/sessions/{conversationId}.jsonl`
- Each message appended as a single JSON line on its own
- On startup: scan sessions directory, load metadata (title, date, message count, model used) into memory
- On tab open: read full JSONL, parse messages into array, populate chat store
- Auto-title: derive from first user message (truncate to 50 chars) or LLM-generated
- Prune: delete sessions older than 30 days on startup (configurable)
- Zustand `persist` middleware for session metadata (lightweight). Full message content stays in JSONL files.

**Message format in JSONL:**
```json
{"role":"user","content":"fix the auth bug","timestamp":1712505600000,"meta":{}}
{"role":"assistant","content":"I'll look at the auth...","toolCalls":[],"timestamp":1712505605000}
{"role":"tool_result","toolCallId":"call_abc123","content":"file contents...","isError":false,"timestamp":1712505610000}
```

**Dependencies:** None (standalone, but Multi-session Management depends on it)

### 10. Task/Plan System

**How it works in Claude Code (HIGH confidence, source-verified):**

From `src/Task.ts`:
- Task types: `local_bash`, `local_agent`, `remote_agent`, `in_process_teammate`, `local_workflow`, `monitor_mcp`, `dream`
- Task statuses: `pending`, `running`, `completed`, `failed`, `killed`
- Task state: `{ id, type, status, description, toolUseId, startTime, endTime, outputFile }`
- ID generation: prefix + 8 random alphanumeric chars (e.g., `b3k9f2x1` for bash task)

From community documentation:
- Dependencies: Task A blocks Task B. When A completes, B becomes available.
- Persistence: Tasks survive session restarts.
- `/plan` command: Agent generates structured task list from user request.

**Recommended simpler approach for wzxClaw:**

Start with a minimal task system:
- Task: `{ id, title, description?, status: 'pending'|'in_progress'|'completed'|'cancelled', dependencyIds: string[], createdAt, completedAt? }`
- Two new tools: `CreateTask(title, description?, dependencyIds?)` and `UpdateTask(taskId, status)`
- Display: Task list panel in sidebar (collapsible, shows status with color coding)
- Dependencies: a task with unmet dependencies stays grayed out / blocked
- The agent uses these tools when working on multi-step problems
- Tasks stored in session (lost on close in v1.2, persisted in future version)

**Dependencies:** None (standalone)

---

## Feature Dependencies

```
Session Persistence ──────► Multi-session Management (tabs need persistent session IDs)
        │                          │
        │                          ▼
        │                   Context Management (per-session token tracking)
        │                          │
        │                          ▼
        │                   Inline Diff Preview (agent edits in active session)
        │                          │
        │                          ▼
        │                   @-mention Context (file injection into active session)
        │
        ▼
Command Palette ────────► All features (keyboard entry points)
        │
        ▼
Terminal Panel ──────────► Bash tool refactored (dual mode: PTY vs silent)
        │
        ▼
More Tools ──────────────► Agent Loop (extend tool registry)
        │
        ▼
Task/Plan System ────────► Standalone (can use Persistence later)

Codebase Indexing ───────► Standalone (DEFER to v1.3)
```

**Recommended implementation order (based on dependencies and value):**

| Phase | Features | Rationale |
|-------|----------|-----------|
| Phase A | Session Persistence, Command Palette | Foundation: persistence enables tabs, palette enables keyboard shortcuts for all features |
| Phase B | Multi-session Management, Context Management | Core UX: tabs for multitasking, context management prevents crashes |
| Phase C | Inline Diff Preview, Terminal Panel | Editor UX: visual diffs for AI edits, terminal for command execution |
| Phase D | @-mention Context, More Tools | Agent power: file injection, LSP, WebSearch |
| Phase E | Task/Plan System | Power-user: structured workflows |
| Phase F | Codebase Indexing | DEFER: massive scope, marginal value for personal tool |

---

## Interaction Between Features

These features interact in important ways that affect implementation:

1. **Context Management + Session Persistence**: Compacted sessions need to be persisted. The compact summary becomes a special message in the JSONL file.

2. **Inline Diff + Terminal**: When the agent runs a command that modifies a file (e.g., `npm install` creating package.json changes), the terminal output and file diff should be coordinated.

3. **Command Palette + Everything**: Every feature registers commands. The palette is the central dispatch. This means features need a standard "command registration" interface.

4. **@-mention + Context Management**: Injecting a large file via @-mention can push context over the threshold. The context manager should warn or auto-compact before sending.

5. **Multi-session + Terminal**: Each terminal instance should be associated with a session. When switching tabs, the terminal should show the commands relevant to that session (or be shared across sessions in a project).

6. **Task System + Context Management**: When context is compacted, active task state should be preserved (tasks are high-priority context that should not be summarized away).

---

## Confidence Assessment

| Area | Confidence | Reason |
|------|------------|--------|
| Context Management | HIGH | Claude Code source code read directly, architecture verified |
| Inline Diff Preview | HIGH | Monaco DiffEditor API confirmed, Cursor behavior documented in forums |
| @-mention Context | HIGH | Cursor implementation documented, straightforward file injection |
| Multi-session Management | MEDIUM | Cursor behavior documented, internal tab state management not public |
| Command Palette | HIGH | Standard UI pattern, well-documented in VS Code |
| Terminal Panel | HIGH | xterm.js + node-pty + Electron is industry standard, multiple references |
| More Tools: LSP | MEDIUM | Claude Code LSPTool verified in source; Monaco LSP integration needs testing |
| More Tools: WebSearch/WebFetch | HIGH | Standard HTTP tools, simple implementation |
| Codebase Indexing | MEDIUM | Cursor architecture documented in official blog; embedding details proprietary |
| Session Persistence | HIGH | Claude Code JSONL pattern verified in source code and docs |
| Task/Plan System | MEDIUM | Claude Code Task.ts verified; dependency tracking adds complexity |

---

## Sources

- [Cursor Terminal Integration Docs](https://cursor.com/help/ai-features/terminal) -- AI terminal commands
- [Cursor Semantic & Agentic Search](https://cursor.com/docs/agent/tools/search) -- Codebase indexing
- [Cursor Secure Codebase Indexing Blog](https://cursor.com/blog/secure-codebase-indexing) -- Merkle tree architecture
- [Claude Code Context Management (Substack)](https://kenhuangus.substack.com/p/claude-code-pattern-6-context-management) -- Compaction patterns
- [Claude Code Context Buffer (claudefast)](https://claudefa.st/blog/guide/mechanics/context-buffer-management) -- 33K token buffer
- [Claude Code Internals Part 13 (Medium)](https://kotrotsos.medium.com/claude-code-internals-part-13-context-management-ffa3f4a0f6b4) -- Token estimation
- [Automatic Context Compaction (Anthropic Cookbook)](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction) -- Official guide
- [Claude Code Session Management (Mintlify)](https://www.mintlify.com/saurav-shakya/Claude_Code-_Source_Code/advanced/session-management) -- JSONL storage
- [Claude Code Local Storage (Milvus Blog)](https://milvus.io/blog/why-claude-code-feels-so-stable-a-developers-deep-dive-into-its-local-storage-design.md) -- JSONL design
- [Claude Code Task Management (claudefast)](https://claudefa.st/blog/guide/development/task-management) -- Dependencies and blockers
- [Cursor Forum: Inline Diff](https://forum.cursor.com/t/how-to-enable-diff-review-ui-after-latest-update/154231) -- Diff UX
- [Cursor Forum: @-mention Context](https://forum.cursor.com/t/i-can-no-longer-add-context-from-another-chat-to-the-new-chat/146444) -- Restrictions
- [Cursor Forum: Chat History](https://forum.cursor.com/t/create-a-unified-chat-history-view-across-all-projects/149955) -- Multi-session
- [How Cursor Indexes Codebases (Towards DS)](https://towardsdatascience.com/how-cursor-actually-indexes-your-codebase/) -- Embedding pipeline
- [xterm.js Official](http://xtermjs.org/) -- Terminal emulator
- [SO: xterm.js + Electron + node-pty](https://stackoverflow.com/questions/63390143/) -- Integration pattern
- [Reddit: Multi-Terminal IDE](https://www.reddit.com/r/electronjs/comments/1r0q2r8/) -- Real-world implementation
- [js-tiktoken for Token Counting](https://www.pkgpulse.com/blog/gpt-tokenizer-vs-js-tiktoken-vs-xenova-transformers-llm-2026) -- Library comparison
- Claude Code source code (`E:\ai\claude-code\src\`) -- Compact pipeline, Task system, LSP, NotebookEdit
- wzxClaw source code (`E:\ai\wzxClaw\src\`) -- Existing types, stores, agent loop
