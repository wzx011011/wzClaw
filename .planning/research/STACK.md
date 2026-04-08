# Technology Stack -- v1.2 Additions

**Project:** wzxClaw -- Cursor-like AI Coding IDE
**Researched:** 2026-04-08
**Scope:** NEW dependencies required for v1.2 milestone features only. Existing v1.0 stack (Electron, React, Monaco, Zustand, OpenAI SDK, Anthropic SDK, etc.) documented in prior STACK.md remains unchanged.

## Summary of New Dependencies

6 new packages across 10 features. 4 features need zero new dependencies.

| Feature | New Dependency? | Key Addition |
|---------|----------------|--------------|
| Context Management | YES | js-tiktoken for token counting |
| Inline Diff Preview | YES | diff library for hunk computation |
| @-mention Context | NO | Custom regex parser, no library |
| Multi-session Management | NO | Zustand stores already available |
| Command Palette | YES | fuse.js for fuzzy search |
| Terminal Panel | YES | @xterm/xterm + node-pty |
| More Tools (WebSearch, WebFetch, LSP, NotebookEdit) | NO | Built on existing Tool interface + Node.js APIs |
| Codebase Indexing | YES | sql.js + sqlite-vec for vector search |
| Session Persistence | NO | Node.js fs for JSONL files |
| Task/Plan System | NO | Custom types + Zustand |

## New Dependencies by Feature

### Feature 1: Context Management (Token Counting, Auto-Compact)

| Library | Version | Purpose | Why | Confidence |
|---------|---------|---------|-----|------------|
| js-tiktoken | ^1.0.21 | BPE token counting | Pure JavaScript port of OpenAI's tiktoken. No WASM dependency, no native compilation. Supports o200k_base (GPT-4o/GPT-4o-mini), cl100k_base (GPT-4/GPT-3.5), and other encodings. Lightweight (~50KB). Runs in both main process and renderer. Essential for context window management -- you must count tokens before sending to LLM to avoid truncation errors. | HIGH |

**Integration points:**
- Main process: `TokenizerService` wraps js-tiktoken, exposes `countTokens(text, model)` method
- Agent Loop: Before each LLM call, compute total token count of messages + tools. If approaching model limit, trigger auto-compact (summarize older messages)
- Chat Panel (renderer): Display token usage counter in UI via IPC stream events
- Model config: Map each model to its encoding (GPT-4o = o200k_base, Claude = approximate via cl100k_base)

**Why not alternatives:**
- `tiktoken` (official WASM port) -- requires wasm loading, heavier, unnecessary complexity
- `gpt-tokenizer` -- less maintained, fewer encoding options
- Approximate counting (words * 1.3) -- too inaccurate for context window management; off by 20-40% on code

```bash
npm install js-tiktoken
```

---

### Feature 2: Inline Diff Preview

| Library | Version | Purpose | Why | Confidence |
|---------|---------|---------|-----|------------|
| diff | ^8.0.0 | Unified diff computation | The standard JS diff library. `structuredPatch()` returns hunk objects with oldStart/newStart/oldLines/newLines/lines arrays. `applyPatch()` for applying accepted hunks. `createTwoFilesPatch()` for full file diffs. Zero dependencies. Used to compute diff hunks from old content vs new content, then render in Monaco or custom UI. | HIGH |

**Integration points:**
- Agent Tool handler: When AI calls `Write` or `Edit` tool, compute diff between current file content and proposed content using `structuredPatch()`
- IPC: Send diff hunks to renderer via new stream event `stream:diff_preview` or extend `stream:tool_use_end`
- Monaco Editor: Use Monaco's built-in `DiffEditor` (already available since `monaco-editor` is a dependency) with `renderSideBySide: false` for inline mode. No extra library needed for rendering -- Monaco handles the coloring
- Accept/Reject UI: Custom React overlay on the Monaco editor for per-hunk accept/reject buttons

**Why not alternatives:**
- `react-diff-viewer-continued` -- adds a React-specific diff renderer, but Monaco already has a built-in DiffEditor that integrates natively. Adding a separate React diff component means maintaining two rendering paths
- `diff-match-patch` (Google) -- optimized for character-level diffs, not line-level hunks. Wrong granularity for code review
- `jsdiff` -- this IS the `diff` package (same npm package, name is `diff`)

```bash
npm install diff
npm install -D @types/diff
```

---

### Feature 3: @-mention Context

No new dependencies. Implementation approach:

- **Parser**: Custom regex-based parser in chat input component. Detect `@` followed by path-like strings, resolve against workspace file tree
- **Autocomplete**: Custom React dropdown component filtering `FileTreeNode[]` from existing Zustand workspace store
- **Context injection**: Resolved file content appended to the user message before sending to Agent Loop
- All building blocks (file tree, file read, Zustand stores) already exist in v1.0

---

### Feature 4: Multi-session Management

No new dependencies. Implementation approach:

- **State**: New Zustand store `useSessionStore` managing `Map<string, Conversation>` with active session ID
- **UI**: Tab bar component above chat panel, each tab maps to a Conversation ID
- **IPC**: Reuse existing `agent:send_message` channel (already has `conversationId` parameter)
- Types `Conversation` and `Message` already defined in `shared/types.ts`

---

### Feature 5: Command Palette

| Library | Version | Purpose | Why | Confidence |
|---------|---------|---------|-----|------------|
| fuse.js | ^7.1.0 | Fuzzy search for command filtering | Zero-dependency fuzzy search library. 4KB gzipped. Perfect for filtering command palette entries as the user types. Supports weighted keys (search command name higher than description), threshold tuning for fuzzy matching quality. Used by many IDEs and developer tools for this exact purpose. | HIGH |

**Integration points:**
- React component: `CommandPalette` overlay with text input + filtered list
- Command registry: New `CommandRegistry` class in main process, commands registered with `id`, `label`, `shortcut`, `handler`
- IPC: New channels `command:list` (get all commands) and `command:execute` (run a command)
- fuse.js instance created in renderer, indexes the command list from main process
- Keyboard shortcut: Global `Ctrl+Shift+P` listener registered via Electron's `globalShortcut` or renderer `keydown`

**Why not alternatives:**
- `fzf` -- Rust-based WASM, overkill for ~50-100 commands
- `minimatch` -- glob matcher, not fuzzy search
- Custom scoring -- fuse.js handles diacritics, weighted keys, and threshold tuning out of the box; reimplementing would be wasted effort

```bash
npm install fuse.js
```

---

### Feature 6: Terminal Panel

| Library | Version | Purpose | Why | Confidence |
|---------|---------|---------|-----|------------|
| @xterm/xterm | ^5.5.0 | Terminal renderer in Electron renderer process | The same terminal emulator VS Code uses. xterm.js moved to `@xterm` scoped package in v5+. Canvas-based rendering, WebGL addon available, full Unicode support, link handling, selection, copy/paste. Integrates with node-pty data stream. This is THE terminal for Electron apps. | HIGH |
| @xterm/addon-fit | ^0.10.0 | Auto-fit terminal to container size | Official xterm addon that resizes terminal columns/rows to match container dimensions. Essential for responsive panel layout. When the terminal panel resizes (via allotment splitter), this addon recalculates terminal dimensions and notifies node-pty via resize IPC. | HIGH |
| node-pty | ^1.0.0 | PTY (pseudo-terminal) in Electron main process | Spawns real shell processes (cmd.exe, PowerShell, bash) with a pseudo-terminal. Provides the bidirectional data stream that @xterm/xterm renders. VS Code's integrated terminal uses this exact library. Required because Node.js `child_process` does not allocate a PTY, so interactive programs (vim, less, programs with colored output) would break. | HIGH |
| @electron/rebuild | ^4.0.0 | Rebuild native modules for Electron | node-pty contains native C++ code. Electron uses a different Node.js ABI than system Node. `@electron/rebuild` recompiles native modules against Electron's Node headers. Must run after `npm install`. Already likely needed if any other native module is added. Can be added as a postinstall script. | HIGH |

**Integration points:**
- Main process: `TerminalManager` class creates/destroys `node-pty` instances. Each terminal gets a unique ID. Data events streamed to renderer via new IPC channels
- Renderer: `TerminalPanel` React component wraps `@xterm/xterm` instance. Receives PTY data from main process, sends user keystrokes back
- IPC channels needed: `terminal:create`, `terminal:write` (user input), `terminal:data` (PTY output to renderer), `terminal:resize`, `terminal:kill`
- Agent integration: Bash tool can optionally route through the visible terminal (so user sees AI's commands) or use headless child_process (current behavior)
- Layout: Terminal panel as a new resizable section below the editor area, using existing `allotment` dependency

**Why not alternatives:**
- `xterm` (unscoped) -- deprecated, all development moved to `@xterm/xterm`
- `child_process` without PTY -- no interactive shell, no color support, no terminal emulation
- `node-pty` alternatives (`pty.js`, `ptyw.js`) -- all unmaintained forks, node-pty is the canonical implementation used by VS Code
- **Important**: node-pty requires `@electron/rebuild`. This adds build complexity but is unavoidable for a real terminal. The rebuild step takes ~30 seconds on first install.

```bash
npm install @xterm/xterm @xterm/addon-fit node-pty
npm install -D @electron/rebuild
```

After install, run rebuild:
```bash
npx electron-rebuild
```

Or add to `package.json` scripts:
```json
"postinstall": "electron-rebuild"
```

---

### Feature 7: More Tools (WebSearch, WebFetch, LSP, NotebookEdit)

No new dependencies. All tools build on the existing `Tool` interface from `src/main/tools/tool-interface.ts`.

Implementation approach per tool:

- **WebSearch**: Use `fetch()` in main process to call a search API (user configures endpoint). Could use SearXNG self-hosted, Brave Search API, or any OpenAI-compatible search. No library needed -- just HTTP calls
- **WebFetch**: Use Node.js `fetch()` (available in Node 22+) to fetch URLs, return HTML/text content. Optionally use a simple HTML-to-text converter if needed
- **LSP Symbol Navigation**: Communicate with language servers via `vscode-languageclient` protocol. For MVP, implement basic `grep`-based symbol search instead. Full LSP is a future enhancement
- **NotebookEdit**: Manipulate `.ipynb` (JSON) files directly. Jupyter notebook format is just JSON with cells -- read with `JSON.parse()`, modify, write with `JSON.stringify()`

Each tool implements the existing `Tool` interface:
```typescript
interface Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly requiresApproval: boolean
  execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult>
}
```

---

### Feature 8: Codebase Indexing (Vector Semantic Search)

| Library | Version | Purpose | Why | Confidence |
|---------|---------|---------|-----|------------|
| sql.js | ^1.11.0 | SQLite database (WASM-based) | Full SQLite compiled to WASM. No native compilation required -- this is critical because node-pty already adds native rebuild complexity, and adding another native dependency (better-sqlite3) doubles the build pain. sql.js stores the entire database in memory (loaded from file on startup, written back on changes). For a personal tool with small-to-medium codebases, performance is more than sufficient. | HIGH |
| sqlite-vec | ^0.1.6 | Vector similarity search extension for SQLite | SQLite extension that adds vector distance functions (cosine, L2). Enables storing code embeddings as vectors and performing similarity search with `SELECT * FROM files WHERE vec_distance_cosine(embedding, ?) < 0.5`. Lightweight, designed specifically for SQLite. Works with sql.js. Stores code chunks with their embeddings, returns ranked results for semantic queries. | MEDIUM |

**Integration points:**
- Main process: `IndexingService` manages sql.js database lifecycle
- Embeddings: Call LLM API (OpenAI `text-embedding-3-small` or compatible) to generate embeddings for code chunks. No local embedding model needed -- API calls are fast enough for indexing
- Indexing pipeline: File watcher (existing chokidar) triggers re-indexing on file changes -> chunk code into ~500 token pieces -> generate embeddings via API -> store in sql.js with sqlite-vec
- Search: User query -> embed query -> vector similarity search -> return ranked code chunks
- Agent integration: New tool `CodebaseSearch` that queries the vector index
- Storage location: Database file stored in app's user data directory (`app.getPath('userData')`)

**Why not alternatives:**
- `better-sqlite3` -- faster (native C++), but requires `@electron/rebuild` for every Electron version upgrade. With node-pty already needing rebuild, adding better-sqlite3 means maintaining two native dependencies. sql.js avoids this entirely
- `SQLite` (native bindings) -- same rebuild problem as better-sqlite3
- `LanceDB` -- vector database written in Rust, requires native compilation. Overkill for personal tool
- `ChromaDB` -- server-based, requires running a separate process. Unnecessary complexity for local single-user app
- Local embedding models (Transformers.js, onnxruntime-node) -- 200MB+ model downloads, GPU dependency, CPU-heavy. API-based embeddings are simpler, faster to implement, and sufficient for personal use

```bash
npm install sql.js
```

Note: sqlite-vec may need manual loading as a SQLite extension. Check compatibility with sql.js WASM at integration time. If sqlite-vec does not work with sql.js WASM, fallback to computing cosine similarity in JavaScript (trivial for <100K vectors):
```typescript
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
```

---

### Feature 9: Session Persistence

No new dependencies. Implementation approach:

- **Storage format**: JSONL (JSON Lines) -- one JSON object per line, each line is a message or metadata event
- **Write**: Append to file on each message (using Node.js `fs.appendFile` in main process)
- **Read**: Read file line-by-line, parse each JSON object, reconstruct conversation
- **Storage location**: `app.getPath('userData')/sessions/{conversationId}.jsonl`
- **Schema**: Each line is `{ type: 'user_message' | 'assistant_message' | 'tool_result' | 'metadata', ...payload }`
- **Load on startup**: Read all .jsonl files, build session list for multi-session UI
- No database needed -- JSONL is the standard for append-only conversation logs (Claude Code uses the same format)

---

### Feature 10: Task/Plan System

No new dependencies. Implementation approach:

- **State**: New Zustand store `useTaskStore` with `Task[]` and `Plan[]` types
- **Types**: Define `Task { id, title, description, status, dependencies[], subtasks[] }` in `shared/types.ts`
- **UI**: Task panel in sidebar, task cards with status indicators, dependency graph visualization
- **Agent integration**: AI can create/update tasks through a new tool or by parsing structured responses
- **Persistence**: Store in JSONL alongside session data (Feature 9)

---

## Complete Installation Commands

```bash
# All new production dependencies
npm install js-tiktoken diff fuse.js @xterm/xterm @xterm/addon-fit node-pty sql.js

# New dev dependencies
npm install -D @types/diff @electron/rebuild

# Rebuild native modules (required for node-pty)
npx electron-rebuild
```

## IPC Channels to Add

New channels needed in `src/shared/ipc-channels.ts`:

```typescript
// Terminal channels
'terminal:create': 'terminal:create',
'terminal:write': 'terminal:write',
'terminal:data': 'terminal:data',
'terminal:resize': 'terminal:resize',
'terminal:kill': 'terminal:kill',

// Session persistence channels
'session:list': 'session:list',
'session:load': 'session:load',
'session:delete': 'session:delete',

// Command palette channels
'command:list': 'command:list',
'command:execute': 'command:execute',

// Codebase indexing channels
'index:status': 'index:status',
'index:reindex': 'index:reindex',
'index:search': 'index:search',

// Diff preview
'stream:diff_preview': 'stream:diff_preview',
```

## New Types to Add in `src/shared/types.ts`

```typescript
// Terminal
interface TerminalInstance {
  id: string
  pid: number
  shell: string
  cwd: string
}

// Command Palette
interface Command {
  id: string
  label: string
  shortcut?: string
  category?: string
}

// Task/Plan
interface Task {
  id: string
  title: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  dependencies: string[]
  subtasks: string[]
  createdAt: number
  updatedAt: number
}

// Diff
interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  content: string
}
```

## What NOT to Add

| Library | Why NOT to add | What to do instead |
|---------|----------------|-------------------|
| langchain.js | Enormous dependency, abstracts away streaming control the Agent loop needs | Direct SDK calls via OpenAI/Anthropic SDKs |
| Transformers.js / onnxruntime-node | 200MB+ model downloads, GPU dependency, overkill for personal tool | LLM API calls for embeddings |
| better-sqlite3 | Native C++ module, requires @electron/rebuild, adds to native dependency maintenance burden | sql.js (WASM, zero native compilation) |
| react-diff-viewer-continued | Monaco already has built-in DiffEditor | Monaco DiffEditor component |
| any vector database (ChromaDB, LanceDB, Milvus) | Server-based or native-heavy, unnecessary for local single-user | sql.js + sqlite-vec or JS cosine similarity |
| eslint-config-prettier / prettier-eslint | Not needed for personal tool development | Keep separate eslint + prettier configs |
| electron-forge | Already using electron-vite + electron-builder, switching tools mid-project is disruptive | Stay with current build toolchain |
| webpack | Legacy, slow, already using Vite via electron-vite | Stay with electron-vite |

## Build Impact Assessment

Adding `node-pty` is the only change that affects the build pipeline:

1. **@electron/rebuild** becomes mandatory -- must run after every `npm install`
2. **electron-builder** config may need `node-pty` listed in `nodeModules` to ensure it's included in the packaged app
3. **CI/CD** (if added later) needs build tools (Visual Studio Build Tools on Windows) for native module compilation
4. **Distribution**: The packaged app will be larger (~5-10MB increase from node-pty native binary)

sql.js (WASM) has zero build impact -- it's pure JavaScript that loads a .wasm file at runtime.

## Sources

- npm registry (registry.npmjs.org) -- version numbers verified 2026-04-08
- js-tiktoken GitHub (github.com/openai/tiktoken/tree/main/js) -- pure JS BPE implementation
- diff npm page (npmjs.com/package/diff) -- unified diff computation API
- fuse.js documentation (fusejs.io) -- fuzzy search configuration options
- xterm.js documentation (xtermjs.org) -- @xterm/xterm v5+ API
- node-pty GitHub (github.com/microsoft/node-pty) -- PTY for Node.js, VS Code's terminal backend
- sql.js GitHub (github.com/sql-js/sql.js) -- SQLite compiled to WASM
- sqlite-vec GitHub (github.com/asg017/sqlite-vec) -- vector similarity for SQLite
- VS Code source (github.com/microsoft/vscode) -- reference for terminal integration patterns
- Claude Code source (E:\ai\claude-code\) -- reference for agent loop, tool system, session persistence
