# Phase 6: Foundation Upgrades - Research

**Researched:** 2026-04-08
**Domain:** Session Persistence, Context Management, Command Palette
**Confidence:** HIGH

## Summary

Phase 6 adds three foundational capabilities to wzxClaw: (1) session persistence so conversations survive app restarts via JSONL files stored in Electron's userData directory, (2) context management with token counting, auto-compaction at 80% of the model's context window, and a `/compact` command, and (3) a VS Code-style command palette with Ctrl+Shift+P, fuzzy search, and a pluggable command registry.

The existing codebase provides clean integration points: `AgentLoop` holds messages in memory (needs persistence hooks), `AgentConfig` already tracks `conversationId`, the chat store manages `ChatMessage[]` in Zustand (needs load/save), and the global keyboard shortcut system in `IDELayout.tsx` is the natural place to register Ctrl+Shift+P.

**Primary recommendation:** Build a `SessionStore` class in the main process for JSONL persistence, add a `ContextManager` class alongside `AgentLoop` for token counting and compaction, and use `cmdk` (v1.1.1) as the command palette UI component backed by a simple `CommandRegistry` class. All three subsystems are independent and can be implemented in parallel waves.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PERSIST-01 | Chat sessions persisted to disk as JSONL files (one JSON object per line, append-only) | SessionStore class using `fs.appendFile` in main process; each message is one JSON line |
| PERSIST-02 | Sessions auto-saved after each agent turn completes | Hook into `AgentDoneEvent` in ipc-handlers.ts to trigger SessionStore.save() |
| PERSIST-03 | On app restart, previous sessions loaded and visible in session list | SessionStore.loadAll() at app startup; IPC channel to send session list to renderer |
| PERSIST-04 | Session restoration recovers messages, tool calls, and usage metadata | JSONL format stores full ChatMessage objects; parse on load |
| PERSIST-05 | Corrupted/malformed lines in JSONL skipped gracefully | Per-line try/catch during JSONL parsing; log and skip bad lines |
| PERSIST-06 | Sessions stored per-project in userData/sessions/{project-hash}/ | Use crypto hash of workspace root path as directory name under `app.getPath('userData')` |
| CTX-01 | Agent loop tracks token usage per conversation turn | AgentLoop already accumulates `totalUsage` in `run()`; expose per-turn via AgentDoneEvent |
| CTX-02 | Token counting via js-tiktoken before each LLM call to estimate context utilization | `js-tiktoken` v1.0.21 with `o200k_base` encoding; count tokens from `Message[]` before building provider messages |
| CTX-03 | Auto-compact triggers when conversation exceeds 80% of model context window | ContextManager checks token count before each LLM turn; triggers compact via LLM summarization call |
| CTX-04 | Compact only between LLM turns, never during active tool execution | Circuit breaker: check `isToolExecutionInProgress` flag in AgentLoop before allowing compact |
| CTX-05 | User can manually trigger compact via /compact command | Parse `/compact` in chat input handler; IPC to main process to trigger ContextManager.compact() |
| CTX-06 | Context window size configurable per model in settings | Extend ModelPreset with `contextWindowSize` field; extend SettingsManager to store per-model config |
| CTX-07 | Tool results truncated to MAX_TOOL_RESULT_CHARS before adding to context | Truncation in AgentLoop after tool execution; constant already exists in constants.ts (30000) |
| CMD-01 | Ctrl+Shift+P opens command palette overlay with fuzzy search | Use `cmdk` v1.1.1 Command.Dialog component; register Ctrl+Shift+P in IDELayout global keydown handler |
| CMD-02 | Commands registered with name, category, shortcut, and handler function | CommandRegistry class in renderer with `register({ id, label, category, shortcut, handler })` |
| CMD-03 | Built-in commands: open file, open folder, new session, clear session, toggle terminal, toggle sidebar, change model, settings | Pre-populate CommandRegistry with 8 commands calling existing store actions |
| CMD-04 | Command palette shows keyboard shortcuts next to command names | cmdk Item component renders shortcut badge alongside label |
| CMD-05 | Plugin system allows future registration of custom commands | CommandRegistry.register() is a public API; store exposed via React context or Zustand |
</phase_requirements>

## Standard Stack

### Core (New Dependencies)

| Library | Version | Purpose | Why Standard | Confidence |
|---------|---------|---------|--------------|------------|
| js-tiktoken | 1.0.21 | BPE token counting for context window estimation | Pure JS port of OpenAI's tiktoken. No native/WASM dependencies -- critical for Electron compatibility. 4M+ weekly downloads. Supports `o200k_base` encoding (GPT-4o/GPT-5 lineage). Requirement CTX-02 explicitly names this library. | HIGH |
| cmdk | 1.1.1 | Command palette UI component | Fast, unstyled, composable React component by pacocoursey. 11.8k GitHub stars, 391k dependents. Built-in fuzzy search/filter. Accessible (ARIA attributes, keyboard navigation). Renders `Command.Dialog` as overlay with full keyboard support. Used by Vercel, Linear, and other production apps. No opinionated styling -- we control all CSS. | HIGH |

### Supporting (Existing, Leveraged Differently)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| uuid | 13.0.0 | Session file naming and message IDs | Already used for conversationId; extend for session file IDs |
| zod | 3.23.0 | JSONL line validation on load | Validate each parsed JSONL line against ChatMessage schema |
| zustand | 5.0.0 | Command registry store in renderer | New store for command palette state (commands list, open/close) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| js-tiktoken | gpt-tokenizer | gpt-tokenizer is faster in benchmarks but js-tiktoken has 4x the weekly downloads and the requirement explicitly names js-tiktoken. Both are pure JS. Stick with js-tiktoken. |
| cmdk | react-command-palette / custom | react-command-palette is opinionated with built-in themes. cmdk is unstyled (matches our CSS approach) and more widely adopted (391k dependents). Custom build wastes time on accessibility and keyboard handling. |
| JSONL persistence | electron-store (JSON) / SQLite | electron-store rewrites entire JSON on every save -- bad for append-only chat messages. SQLite is overkill for sequential message storage. JSONL is append-only, one-message-per-line, and corruption-resilient (skip bad lines). |

**Installation:**
```bash
npm install js-tiktoken cmdk
```

**Version verification:**
```
js-tiktoken: 1.0.21 (verified via npm registry, 2026-04-08)
cmdk: 1.1.1 (verified via npm registry, 2026-04-08)
```

## Architecture Patterns

### Recommended Project Structure (New Files)

```
src/
├── main/
│   ├── persistence/
│   │   ├── session-store.ts      # JSONL read/write/append
│   │   └── __tests__/
│   │       └── session-store.test.ts
│   ├── context/
│   │   ├── context-manager.ts    # Token counting + compaction logic
│   │   ├── token-counter.ts      # js-tiktoken wrapper
│   │   └── __tests__/
│   │       ├── context-manager.test.ts
│   │       └── token-counter.test.ts
│   └── ... (existing)
├── renderer/
│   ├── components/
│   │   ├── CommandPalette.tsx     # cmdk wrapper component
│   │   └── ... (existing)
│   ├── stores/
│   │   ├── command-store.ts       # Command registry (Zustand)
│   │   └── ... (existing)
│   └── ... (existing)
└── shared/
    ├── types.ts                   # Extended with SessionMeta, CommandDef
    ├── constants.ts               # Extended with context window defaults
    └── ipc-channels.ts            # Extended with persistence/context channels
```

### Pattern 1: JSONL Session Persistence (Main Process)

**What:** Append-only JSONL file per conversation, one `ChatMessage` JSON object per line. File path: `userData/sessions/{project-hash}/{sessionId}.jsonl`.

**When to use:** Every agent turn completion triggers an append. App startup triggers a directory scan to load session list.

**Example:**
```typescript
// src/main/persistence/session-store.ts
import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export interface SessionMeta {
  id: string
  title: string          // First 50 chars of first user message
  createdAt: number
  updatedAt: number
  messageCount: number
}

export class SessionStore {
  private sessionsDir: string
  private projectHash: string

  constructor(workspaceRoot: string) {
    const userData = app.getPath('userData')
    this.projectHash = crypto
      .createHash('sha256')
      .update(workspaceRoot)
      .digest('hex')
      .substring(0, 16)
    this.sessionsDir = path.join(userData, 'sessions', this.projectHash)
    fs.mkdirSync(this.sessionsDir, { recursive: true })
  }

  appendMessage(sessionId: string, message: unknown): void {
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`)
    const line = JSON.stringify(message) + '\n'
    fs.appendFileSync(filePath, line, 'utf-8')
  }

  loadSession(sessionId: string): unknown[] {
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`)
    if (!fs.existsSync(filePath)) return []
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)
    const messages: unknown[] = []
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line))
      } catch {
        // Skip malformed line (PERSIST-05)
        console.warn(`Skipping malformed line in ${sessionId}.jsonl`)
      }
    }
    return messages
  }

  listSessions(): SessionMeta[] {
    // Scan sessionsDir for *.jsonl files, read first line for title, stat for timestamps
  }
}
```

### Pattern 2: Context Manager with Circuit Breaker (Main Process)

**What:** Token counter runs before each LLM call. If context exceeds 80% of model's window, compaction triggers. Compaction sends old messages to LLM for summarization. A circuit breaker prevents compaction during tool execution.

**When to use:** Before every `gateway.stream()` call in AgentLoop. Also on explicit `/compact` command.

**Example:**
```typescript
// src/main/context/token-counter.ts
import { Tiktoken } from 'js-tiktoken/lite'
import o200k_base from 'js-tiktoken/ranks/o200k_base'

// Singleton encoder -- loaded once, reused across calls
const encoder = new Tiktoken(o200k_base)

export function countTokens(text: string): number {
  return encoder.encode(text).length
}

export function countMessagesTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    total += countTokens(JSON.stringify(msg))  // Overestimate; includes role/structural overhead
  }
  return total
}
```

```typescript
// src/main/context/context-manager.ts
export class ContextManager {
  private isCompacting = false

  getContextWindowForModel(modelId: string): number {
    // Look up from extended ModelPreset or settings
    // Default: 128000 for GLM models, 200000 for Claude
  }

  shouldCompact(messages: Message[], modelId: string): boolean {
    if (this.isCompacting) return false  // Circuit breaker
    const tokens = countMessagesTokens(messages)
    const limit = this.getContextWindowForModel(modelId)
    return tokens > limit * 0.8
  }

  async compact(messages: Message[]): Promise<{ summary: string; keptRecentCount: number }> {
    this.isCompacting = true
    try {
      // Keep last N messages intact, summarize the rest via LLM
      const recentCount = 4  // Last 2 exchanges
      const toSummarize = messages.slice(0, -recentCount)
      const toKeep = messages.slice(-recentCount)
      // Call LLM to generate summary of toSummarize
      // Return summary as system-like message + toKeep
    } finally {
      this.isCompacting = false
    }
  }
}
```

### Pattern 3: Command Palette (Renderer)

**What:** `cmdk` Command.Dialog component triggered by Ctrl+Shift+P. Commands registered in a Zustand store with `register()` API. Built-in commands cover existing actions.

**When to use:** Global keyboard shortcut in IDELayout opens the palette overlay. Command registration happens at app init and from feature modules.

**Example:**
```typescript
// src/renderer/stores/command-store.ts
import { create } from 'zustand'

export interface CommandDef {
  id: string
  label: string
  category: string
  shortcut?: string
  handler: () => void | Promise<void>
}

interface CommandState {
  commands: CommandDef[]
  paletteOpen: boolean
}

interface CommandActions {
  register: (cmd: CommandDef) => void
  unregister: (id: string) => void
  execute: (id: string) => void
  openPalette: () => void
  closePalette: () => void
}

export const useCommandStore = create<CommandState & CommandActions>((set, get) => ({
  commands: [],
  paletteOpen: false,
  register: (cmd) => set((s) => ({
    commands: [...s.commands.filter(c => c.id !== cmd.id), cmd]
  })),
  unregister: (id) => set((s) => ({
    commands: s.commands.filter(c => c.id !== id)
  })),
  execute: (id) => {
    const cmd = get().commands.find(c => c.id === id)
    if (cmd) cmd.handler()
  },
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
}))
```

```tsx
// src/renderer/components/CommandPalette.tsx
import { Command } from 'cmdk'
import { useCommandStore } from '../stores/command-store'

export default function CommandPalette() {
  const { commands, paletteOpen, closePalette, execute } = useCommandStore()

  if (!paletteOpen) return null

  return (
    <Command.Dialog open={paletteOpen} onOpenChange={(open) => { if (!open) closePalette() }} label="Command Palette">
      <Command.Input placeholder="Type a command..." />
      <Command.List>
        <Command.Empty>No results found.</Command.Empty>
        {/* Group by category */}
        {groupByCategory(commands).map(([category, cmds]) => (
          <Command.Group key={category} heading={category}>
            {cmds.map((cmd) => (
              <Command.Item
                key={cmd.id}
                value={cmd.label}
                onSelect={() => { execute(cmd.id); closePalette() }}
              >
                <span>{cmd.label}</span>
                {cmd.shortcut && <span className="cmd-shortcut">{cmd.shortcut}</span>}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  )
}
```

### Anti-Patterns to Avoid

- **Rewriting full JSON on every save:** Use JSONL append, not JSON rewrite. JSONL append is O(1) per message; JSON rewrite is O(n).
- **Compacting during tool execution:** Can lose tool results that are in-flight. Always check the circuit breaker flag.
- **Loading all sessions fully into memory on startup:** Only load session metadata (first line + file stat) for the session list. Load full messages lazily when user opens a session.
- **Using js-tiktoken full import:** `import { getEncoding } from 'js-tiktoken'` bundles ALL encodings. Use `import { Tiktoken } from 'js-tiktoken/lite'` with `import o200k_base from 'js-tiktoken/ranks/o200k_base'` to keep bundle small.
- **Token counting per-character:** Tokens are not characters. Use BPE encoding via js-tiktoken, not `text.length / 4` heuristics.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| BPE token counting | Custom character-based estimation | js-tiktoken | BPE encoding is model-specific; character heuristics can be off by 50%+ on non-English text |
| Fuzzy search for command palette | Custom filter/sort algorithm | cmdk built-in filter | cmdk handles keyboard navigation, accessibility, ranking, and virtual scrolling. Custom implementation would miss edge cases |
| Command palette dialog/modal | Custom overlay with keyboard trap | cmdk Command.Dialog | Accessible by default (Radix UI Dialog internally), handles focus trap, escape key, click-outside-close |
| File append atomicity | Custom locking mechanism | Node.js `fs.appendFileSync` | OS-level append is atomic for writes under PIPE_BUF (4096 bytes on Linux). Our JSONL lines are typically under this limit |
| Project-specific session storage | Flat directory with filename encoding | Hash-based subdirectories | SHA-256 hash of workspace root prevents path collisions and special character issues in directory names |

**Key insight:** The command palette is a UI interaction pattern with significant accessibility and keyboard navigation complexity. `cmdk` solves this completely for 5KB gzipped. Token counting requires the exact BPE vocabulary used by the model; any approximation will cause either wasted context space or overflow errors.

## Common Pitfalls

### Pitfall 1: JSONL File Corruption on App Crash
**What goes wrong:** If the app crashes mid-write, the last JSONL line may be truncated (missing closing `}`).
**Why it happens:** `fs.appendFileSync` is not transactional; a crash can leave a partial write.
**How to avoid:** Per-line try/catch during load (PERSIST-05). Each line is parsed independently, so one bad line does not affect the rest. Also consider using `fs.appendFileSync` (synchronous) rather than async for critical writes.
**Warning signs:** Sessions that load fewer messages than expected.

### Pitfall 2: Auto-Compact During Tool Execution Loses Context
**What goes wrong:** Compaction replaces messages with a summary while tool results are still being processed. The LLM never sees the full tool output.
**Why it happens:** AgentLoop's main loop does not distinguish between "about to call LLM" and "in the middle of tool execution" when checking context size.
**How to avoid:** Circuit breaker pattern (CTX-04). Only check/trigger compact at the top of the main loop (before `gateway.stream()`), never after tool execution. Add an `isToolExecutionInProgress` boolean flag.
**Warning signs:** LLM responses that seem unaware of recent tool results.

### Pitfall 3: js-tiktoken Bundle Size Blow-Up
**What goes wrong:** Importing `import { getEncoding } from 'js-tiktoken'` bundles ALL token encodings (cl100k_base, p50k_base, r50k_base, o200k_base), adding ~1MB+ to the bundle.
**Why it happens:** The default export includes all encoding rank tables.
**How to avoid:** Use the `/lite` import path: `import { Tiktoken } from 'js-tiktoken/lite'` and load only the `o200k_base` ranks.
**Warning signs:** Main process bundle size increases significantly after adding js-tiktoken.

### Pitfall 4: Token Count Mismatch Between Estimation and Actual
**What goes wrong:** Our token count estimates context usage, but the actual API call uses a slightly different tokenization (different encoding for some models, or different message structure overhead).
**Why it happens:** Each provider counts tokens differently. OpenAI counts message overhead (role, formatting). Anthropic has a different tokenizer entirely.
**How to avoid:** (1) Use `o200k_base` as a reasonable approximation for all models -- it is close enough for trigger decisions. (2) Add 10-15% safety margin to the 80% threshold. (3) After each API response, use the actual `usage.inputTokens` from the response to calibrate.
**Warning signs:** Context overflow API errors despite our counter showing under 80%.

### Pitfall 5: Command Palette Not Closing on Escape
**What goes wrong:** Command palette stays open when user presses Escape.
**Why it happens:** cmdk's Dialog handles Escape natively, but if a custom `onKeyDown` handler on the Command root calls `preventDefault()` on Escape, it blocks the built-in close behavior.
**How to avoid:** Do not intercept Escape in the Command component's `onKeyDown`. Let cmdk handle it. Only add custom key handling for non-conflicting keys.
**Warning signs:** Escape key does nothing when palette is open.

### Pitfall 6: Session List Empty After Restart (Wrong userData Path)
**What goes wrong:** Sessions saved during one run are not found on the next run.
**Why it happens:** Electron's `app.getPath('userData')` can differ between development (electron-vite dev) and production (packaged app). The path depends on the `app.name` field in package.json.
**How to avoid:** Use `app.getPath('userData')` consistently (never hardcode). Verify the path at startup with a log statement. The session directory should be `%APPDATA%/wzxclaw/sessions/` on Windows.
**Warning signs:** SessionsDir is empty on startup despite sessions existing in a different path.

## Code Examples

### Token Counting with js-tiktoken (Lite Import)
```typescript
// Source: js-tiktoken npm README + verified API
import { Tiktoken } from 'js-tiktoken/lite'
import o200k_base from 'js-tiktoken/ranks/o200k_base'

// Create encoder once (module-level singleton)
const encoder = new Tiktoken(o200k_base)

// Count tokens for a string
function countTokens(text: string): number {
  return encoder.encode(text).length
}

// Count tokens for a message array (overestimate includes JSON structure overhead)
function estimateContextTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    // Role + content + metadata overhead
    total += 4  // approximate per-message overhead
    if (msg.role === 'user') {
      total += countTokens(msg.content)
    } else if (msg.role === 'assistant') {
      total += countTokens(msg.content)
      for (const tc of msg.toolCalls) {
        total += countTokens(JSON.stringify(tc.input))
      }
    } else if (msg.role === 'tool_result') {
      total += countTokens(msg.content)
    }
  }
  return total
}
```

### JSONL Append with Graceful Corruption Handling
```typescript
// Source: Standard JSONL pattern for append-only storage
import fs from 'fs'

function appendMessage(filePath: string, message: ChatMessage): void {
  const line = JSON.stringify(message) + '\n'
  fs.appendFileSync(filePath, line, 'utf-8')
}

function loadMessages(filePath: string): ChatMessage[] {
  if (!fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, 'utf-8')
  const messages: ChatMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      messages.push(JSON.parse(line) as ChatMessage)
    } catch (err) {
      console.warn(`Skipping malformed JSONL line: ${(err as Error).message}`)
    }
  }
  return messages
}
```

### Compaction Trigger in AgentLoop Integration Point
```typescript
// Source: Analysis of existing agent-loop.ts structure
// This code shows WHERE to integrate context checking,
// not the full implementation.

// In AgentLoop.run(), BEFORE the for loop iteration's gateway.stream() call:
const tokenCount = contextManager.estimateTokens(this.messages)
const contextWindow = contextManager.getContextWindow(config.model)

if (tokenCount > contextWindow * 0.8) {
  // Trigger compaction: summarize older messages
  const { summary, keptRecentCount } = await contextManager.compact(
    this.messages,
    this.gateway,
    config
  )
  // Replace messages with [summary_message, ...recent_messages]
  this.messages = contextManager.applyCompaction(this.messages, summary, keptRecentCount)
  yield { type: 'agent:compacted', beforeTokens: tokenCount, afterTokens: contextManager.estimateTokens(this.messages) }
}
```

### cmdk Dialog with Category Grouping
```tsx
// Source: cmdk README (github.com/pacocoursey/cmdk)
import { Command } from 'cmdk'

function CommandPalette({ open, onOpenChange, commands }) {
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command Palette"
      className="command-palette"
    >
      <Command.Input className="cmd-input" />
      <Command.List className="cmd-list">
        <Command.Empty>No matching commands</Command.Empty>
        {Object.entries(groupBy(commands, 'category')).map(([cat, cmds]) => (
          <Command.Group key={cat} heading={cat}>
            {cmds.map(cmd => (
              <Command.Item
                key={cmd.id}
                value={cmd.label}
                onSelect={() => cmd.handler()}
                className="cmd-item"
              >
                <span>{cmd.label}</span>
                {cmd.shortcut && <kbd>{cmd.shortcut}</kbd>}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  )
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Full JSON rewrite for persistence | JSONL append-only | Industry standard for event sourcing / chat history | Faster writes, corruption resilient |
| Character-length heuristics for tokens | BPE tokenization (js-tiktoken) | tiktoken released 2023, JS port matured 2024-2025 | Accurate counting critical for context window management |
| Custom command palette UI | cmdk component | cmdk v1.0 released 2023, v1.1.1 March 2025 | Accessible, tested, keyboard-first |
| Manual context truncation (cut old messages) | LLM-powered summarization/compaction | Claude Code pattern popularized 2024-2025 | Preserves conversation intent rather than just recent messages |
| Flat file storage for sessions | Per-project directory isolation | VS Code workspace pattern | Prevents session bleed between projects |

**Deprecated/outdated:**
- `@dqbd/tiktoken`: WASM-based, adds native build complexity. js-tiktoken (pure JS) is the replacement.
- `react-command-palette` (asabaylus): Last maintained 2022. cmdk is the modern successor.

## Open Questions

1. **Anthropic Tokenizer Accuracy**
   - What we know: js-tiktoken uses OpenAI's BPE encoding. Anthropic uses a different tokenizer.
   - What's unclear: How much the token counts diverge between `o200k_base` and Anthropic's tokenizer.
   - Recommendation: Use `o200k_base` as a universal approximation. Add 15% safety margin for Anthropic models. The trigger point is a heuristic anyway (80% threshold), not an exact boundary.

2. **Compaction Summary Quality**
   - What we know: Claude Code uses LLM-generated summaries for compaction. The compaction prompt matters greatly.
   - What's unclear: What prompt produces the best summary for coding context (tool calls, file references, error traces).
   - Recommendation: Start with a simple compaction prompt: "Summarize the following conversation, preserving: (1) what files were read/modified, (2) what errors were encountered, (3) what decisions were made, (4) the user's original intent." Iterate based on experience.

3. **Session Title Generation**
   - What we know: PERSIST requirements do not specify session titles, but UX requires them for the session list.
   - What's unclear: Whether to use LLM-generated titles (costs tokens, better quality) or first-N-characters of first user message (free, adequate).
   - Recommendation: Use first 50 characters of first user message as title. Fast, free, good enough for MVP. LLM-generated titles can be a future enhancement.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Build + Runtime | Yes | 24.13.0 | -- |
| npm | Package management | Yes | 11.6.2 | -- |
| js-tiktoken | Token counting (CTX) | No (needs install) | -- | `npm install js-tiktoken` |
| cmdk | Command palette (CMD) | No (needs install) | -- | `npm install cmdk` |
| Electron userData dir | Session persistence | Yes | Auto-created | -- |
| vitest | Testing | Yes | 3.x (installed) | -- |

**Missing dependencies with no fallback:**
- js-tiktoken: Required for CTX-02. Must be installed before implementation.
- cmdk: Required for CMD-01. Must be installed before implementation.

**Missing dependencies with fallback:**
- None identified.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 3.x |
| Config file | vitest.config.ts (at project root) |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npm test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PERSIST-01 | JSONL append writes one message per line | unit | `npx vitest run src/main/persistence/__tests__/session-store.test.ts -t "append"` | Wave 0 |
| PERSIST-02 | Auto-save triggers after agent done event | unit | `npx vitest run src/main/persistence/__tests__/session-store.test.ts -t "auto-save"` | Wave 0 |
| PERSIST-03 | Sessions loaded from disk on startup | unit | `npx vitest run src/main/persistence/__tests__/session-store.test.ts -t "load"` | Wave 0 |
| PERSIST-04 | Full message/tool call restoration from JSONL | unit | `npx vitest run src/main/persistence/__tests__/session-store.test.ts -t "restore"` | Wave 0 |
| PERSIST-05 | Malformed lines skipped gracefully | unit | `npx vitest run src/main/persistence/__tests__/session-store.test.ts -t "corruption"` | Wave 0 |
| PERSIST-06 | Per-project directory isolation | unit | `npx vitest run src/main/persistence/__tests__/session-store.test.ts -t "project-hash"` | Wave 0 |
| CTX-01 | Token usage tracked per turn | unit | `npx vitest run src/main/context/__tests__/context-manager.test.ts -t "usage"` | Wave 0 |
| CTX-02 | js-tiktoken token counting accuracy | unit | `npx vitest run src/main/context/__tests__/token-counter.test.ts` | Wave 0 |
| CTX-03 | Auto-compact at 80% threshold | unit | `npx vitest run src/main/context/__tests__/context-manager.test.ts -t "auto-compact"` | Wave 0 |
| CTX-04 | Compact blocked during tool execution | unit | `npx vitest run src/main/context/__tests__/context-manager.test.ts -t "circuit breaker"` | Wave 0 |
| CTX-05 | /compact command triggers manual compaction | integration | `npx vitest run src/main/context/__tests__/context-manager.test.ts -t "manual compact"` | Wave 0 |
| CTX-06 | Context window configurable per model | unit | `npx vitest run src/main/context/__tests__/context-manager.test.ts -t "window config"` | Wave 0 |
| CTX-07 | Tool result truncation | unit | `npx vitest run src/main/context/__tests__/context-manager.test.ts -t "truncation"` | Wave 0 |
| CMD-01 | Ctrl+Shift+P opens palette | manual-only | N/A -- renderer keyboard event test | N/A |
| CMD-02 | Command registration with metadata | unit | `npx vitest run src/renderer/stores/__tests__/command-store.test.ts` | Wave 0 |
| CMD-03 | Built-in commands execute correctly | unit | `npx vitest run src/renderer/stores/__tests__/command-store.test.ts -t "built-in"` | Wave 0 |
| CMD-04 | Keyboard shortcuts displayed | manual-only | Visual verification in running app | N/A |
| CMD-05 | External register() API works | unit | `npx vitest run src/renderer/stores/__tests__/command-store.test.ts -t "plugin"` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/main/persistence/__tests__/session-store.test.ts` -- covers PERSIST-01 through PERSIST-06
- [ ] `src/main/context/__tests__/token-counter.test.ts` -- covers CTX-02
- [ ] `src/main/context/__tests__/context-manager.test.ts` -- covers CTX-01, CTX-03, CTX-04, CTX-05, CTX-06, CTX-07
- [ ] `src/renderer/stores/__tests__/command-store.test.ts` -- covers CMD-02, CMD-03, CMD-05
- [ ] js-tiktoken install: `npm install js-tiktoken cmdk`

## Integration Points with Existing Code

### Where Persistence Hooks Into Current Architecture

1. **`ipc-handlers.ts`**: After `agent:done` event is yielded (line 121), call `sessionStore.appendMessage()` for each message in the completed turn. This is the auto-save trigger (PERSIST-02).

2. **`chat-store.ts`**: The `init()` function needs to be extended to request session list from main process via IPC. A new IPC channel `session:list` returns `SessionMeta[]`. The `clearConversation` action should also notify main process to optionally delete the session file.

3. **`src/main/index.ts`**: At app startup (line 93 `app.whenReady()`), create `SessionStore` instance with current workspace root. Pass it to `registerIpcHandlers()`.

4. **`preload/index.ts`**: Add new IPC channels for session management (`session:list`, `session:load`, `session:delete`, `context:compact`).

### Where Context Management Hooks In

1. **`agent-loop.ts`**: Before the `gateway.stream()` call (line 116), insert token count check and compaction trigger. The `ContextManager` is injected via constructor (same pattern as `gateway`, `toolRegistry`, `permissionManager`).

2. **`shared/constants.ts`**: The `ModelPreset` interface needs a `contextWindowSize` field. Extend `DEFAULT_MODELS` with context window sizes.

3. **`shared/types.ts`**: Add `AgentCompactedEvent` to the `AgentEvent` union for compact notifications.

4. **`ipc-channels.ts`**: Add `context:compact` channel for manual `/compact` command from chat input.

### Where Command Palette Hooks In

1. **`IDELayout.tsx`**: Add Ctrl+Shift+P handler in the existing global `keydown` listener (line 39). Toggle `commandStore.openPalette()`.

2. **`IDELayout.tsx`**: Render `<CommandPalette />` component as a sibling to the Allotment container (it renders as a fixed overlay via cmdk's Dialog).

3. **Built-in commands**: Register in a `useEffect` in IDELayout:
   - `open-folder` -> `workspaceStore.openFolder()`
   - `new-session` -> `chatStore.clearConversation()`
   - `clear-session` -> `chatStore.clearConversation()`
   - `toggle-sidebar` -> toggle sidebar visibility
   - `change-model` -> open settings modal
   - `settings` -> open settings modal
   - `save-file` -> `tabStore.saveTab(activeTabId)`

## Sources

### Primary (HIGH confidence)
- npm registry (registry.npmjs.org) -- js-tiktoken v1.0.21, cmdk v1.1.1 verified 2026-04-08
- js-tiktoken npm README -- API usage, lite import pattern
- cmdk GitHub README (github.com/pacocoursey/cmdk) -- Command.Dialog API, filter, grouping
- wzxClaw source code -- existing AgentLoop, chat-store, ipc-handlers, types (all read and analyzed)

### Secondary (MEDIUM confidence)
- PkgPulse blog (pkgpulse.com/blog) -- js-tiktoken vs gpt-tokenizer comparison (2026 article)
- Anthropic cookbook (platform.claude.com/cookbook) -- context compaction patterns
- Multiple community sources -- Claude Code compaction mechanism description

### Tertiary (LOW confidence)
- VS Code command palette behavior -- based on experience, not source code analysis

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- js-tiktoken and cmdk are mature, well-documented, verified on npm registry
- Architecture: HIGH -- integration points are clear from reading existing codebase; patterns follow established code conventions
- Pitfalls: HIGH -- based on known issues with JSONL, js-tiktoken, and cmdk documented in their respective issue trackers and community discussions

**Research date:** 2026-04-08
**Valid until:** 2026-05-08 (30 days -- stable libraries, unlikely to change significantly)
