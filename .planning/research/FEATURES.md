# Feature Landscape

**Domain:** AI Coding IDE (Cursor-like desktop application)
**Researched:** 2026-04-03
**Competitors analyzed:** Cursor, Windsurf, GitHub Copilot in VS Code, Qoder

## Table Stakes

Features users expect. Missing = product feels incomplete. Every AI coding IDE in 2026 has these.

### Chat Panel (Conversation UI)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Sidebar chat panel | Core interaction model for all AI IDEs. Cursor (Cmd+L), Windsurf (Cmd+L), Copilot all use sidebar chat | Med | Must be resizable, dockable, collapsible |
| Streaming response display | Users expect real-time token-by-token output. Non-streaming feels broken | Med | SSE/WebSocket streaming from LLM API |
| Code block rendering in chat | Chat must render syntax-highlighted code blocks with language detection | Low | Use Monaco's syntax engine or a markdown renderer |
| One-click apply of code changes | Cursor, Copilot, Windsurf all offer "Apply" button on code blocks to insert into editor | Med | Diff view before applying is expected |
| Message history in session | Conversations are multi-turn; losing context within a session is unacceptable | Low | Store messages in memory; persist across sessions for bonus |
| Clear/reset conversation | Standard UX; users need to start fresh | Low | Clear messages array |
| Copy code from chat | Every AI IDE supports one-click copy on code blocks | Low | Clipboard API |
| Stop generation mid-stream | Users must be able to cancel a long-running response | Low | AbortController on the streaming request |
| Markdown rendering in responses | LLMs output markdown; chat must render headings, lists, bold, links, tables | Low | Use a markdown renderer (e.g., react-markdown) |

### Agent Tool System

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| File read | Agent must read files to understand codebase context | Med | Read tool returns file contents with line numbers |
| File write/create | Agent must create new files for scaffolding | Med | Write tool creates or overwrites files |
| File edit (targeted) | Agent must make surgical edits to existing files, not rewrite entire files | High | Edit tool uses search-and-replace or diff-based editing. Claude Code's Edit tool is the reference pattern |
| Bash/terminal execution | Agent must run commands (build, test, lint, install) | High | Critical for autonomous workflows. Cursor's sandbox model is the gold standard |
| Code search (grep) | Agent must search codebase to find relevant patterns | Med | Grep tool with regex support |
| File search (glob) | Agent must find files by name pattern | Low | Glob tool for file discovery |
| Tool call visualization | Users must see what tools the agent is calling, with inputs and outputs | Med | Cursor, Copilot, and Windsurf all show tool calls in chat timeline |
| Tool approval/rejection | Users must approve or reject tool calls (especially destructive ones) | Med | Permission prompts for file writes and bash commands |

### LLM Integration

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| OpenAI-compatible API support | The de facto standard API format. DeepSeek, local models, and most providers use it | Med | OpenAI chat completions format with streaming |
| API key configuration | Users must be able to input their own API keys | Low | Settings panel with secure storage |
| Model selection | Users expect to choose which model to use (GPT-4, Claude, DeepSeek, etc.) | Med | Dropdown or settings to switch models mid-conversation |
| Streaming responses | Non-negotiable for UX. Users will not wait for full responses | Med | SSE streaming for OpenAI-compatible APIs |
| Multi-turn conversation context | Chat must maintain conversation history and send to LLM | Low | Messages array management |
| System prompt support | Agent needs instructions for behavior (tool use, safety, style) | Low | Configurable system prompt |

### Editor Integration

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| File tree (explorer) | Every IDE has a file tree. Monaco alone is insufficient | Med | Use a file tree component; integrate with workspace root |
| Tab-based file editing | Multiple open files in tabs is standard IDE behavior | Med | Monaco editor instances per tab |
| Syntax highlighting | Basic expectation for any code editor | Low | Monaco provides this out of the box |
| Open file from agent | When agent creates or edits a file, user expects it to open in the editor | Low | Event from agent -> open file in new tab |
| Cursor position tracking | Agent should know where the user's cursor is for context | Low | Track Monaco cursor position and send to agent |

### Project Management

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Open folder as workspace | The fundamental action of an IDE. Without it, nothing works | Med | Electron dialog -> set workspace root |
| Basic workspace settings | Users need to configure project-specific options | Low | `.wzxclaw/` or similar config directory |
| File watcher | Agent and editor should reflect file system changes in real-time | Med | chokidar or fs.watch for file system events |

## Differentiators

Features that set product apart. Not expected, but valued. These represent competitive advantage.

### Tier 1: High-Value Differentiators (Build First)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| @-mentions in chat | Cursor's killer UX feature. Type `@` to attach files, folders, code symbols, docs to context. Massive productivity boost | High | Cursor supports @Files, @Folders, @Code, @Docs, @Web, @Codebase, @PastChats. Start with @Files and @Folders |
| Checkpoints / undo system | Cursor's checkpoint system saves codebase snapshots before agent changes. One-click rollback if agent goes wrong | High | Git-based or snapshot-based. Critical for trust in autonomous agents |
| Context-aware agent | Agent that reads cursor position, open files, selected text to provide contextual responses without explicit @-mentions | High | Cursor and Windsurf both track user actions (edits, terminal, clipboard) to infer intent |
| Multi-model support per-task | Let users pick different models for different tasks (e.g., cheap model for chat, powerful model for agent) | Med | Cursor offers per-prompt model selection. Unique value for a BYOK (bring your own key) tool |
| Plan mode | Agent generates an implementation plan before executing. Users review and approve plan, then agent executes | Med | Cursor and Copilot both offer plan mode. Reduces risk of autonomous agents going off track |

### Tier 2: Medium-Value Differentiators (Build Next)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Inline edit (Cmd+K) | Select code, press Cmd+K, type instruction, get inline diff preview. Cursor's most-used feature after Tab | High | Requires deep Monaco integration for inline diff rendering |
| Tab completion | AI-powered autocomplete as you type. Predicts multi-line edits, auto-imports | Very High | Cursor's Tab supports multi-line, cross-file suggestions. Requires dedicated inference model or API |
| Rules / custom instructions | Project-level `.cursorrules` or similar files that guide AI behavior across conversations | Low | Simple file-based config that gets injected into system prompt. High ROI |
| Debug mode | Agent instruments running app with logs, finds root cause of bugs. Cursor 2.2 feature | Very High | Requires runtime integration with debuggers. Defer significantly |
| Queued messages | Queue follow-up messages while agent is working. Cursor supports this natively | Low | Message queue that processes after current task completes |
| Conversation history persistence | Save and resume past conversations. Copilot and Cursor both support session history | Med | Local storage (IndexedDB or SQLite) for conversation persistence |

### Tier 3: Long-Term Differentiators (Build Later)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| MCP (Model Context Protocol) support | Extend agent with external tools and data sources. Cursor and VS Code both support MCP | High | Standard protocol for tool integration. Growing ecosystem |
| Browser tool | Agent can control a browser to test web apps, inspect UI, convert designs to code. Cursor has this | Very High | Requires embedded browser (Chromium) with automation |
| Codebase indexing / semantic search | Index entire codebase for semantic search. Enables @Codebase and intelligent context retrieval | Very High | Embeddings + vector store. Cursor does this internally |
| Memories / persistent context | Agent remembers facts across sessions. Windsurf's Cascade Memories auto-save key context | Med | Local knowledge base that persists across conversations |
| Multi-agent / expert panel | Multiple agents working in parallel on different aspects. Qoder's Expert Panel mode | Very High | Orchestration layer for parallel agent execution |
| Cloud agent | Agent runs on remote infrastructure for long-running tasks. Copilot's cloud agent | Very High | Requires backend infrastructure. Out of scope for personal tool |
| Code review automation | AI reviews PRs and suggests changes. Copilot and Windsurf offer this | High | Requires Git integration and diff analysis |
| App deploy | One-click deploy from IDE. Windsurf offers Netlify deploy | Very High | Requires cloud infrastructure partnerships |

## Anti-Features

Features to explicitly NOT build. These distract from core value or add complexity without ROI for a personal tool.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| User authentication / accounts | Personal tool, single user. Auth systems add massive complexity for zero value | Store config locally. No server-side accounts |
| Billing / subscription system | Personal tool. No revenue model needed | N/A |
| Multi-user collaboration | Personal tool. Real-time collab (Live Share, etc.) is enterprise complexity | Single-user desktop app |
| Extension marketplace | Massive ecosystem effort. VS Code's marketplace took years | Support VS Code extensions via Monaco compatibility, or just don't |
| Built-in Git UI | VS Code's Git UI is already excellent; reimplementing is wasted effort | Shell out to git CLI, or integrate a git extension |
| Terminal emulator | VS Code's terminal is a massive subsystem. xterm.js integration is complex | Use agent's bash tool for command execution. Users can use external terminal |
| Cloud sync of settings | Personal tool on one machine. Cloud sync adds auth + backend dependency | Local config files only |
| Vim/Emacs keybinding modes | Monaco has basic keybindings. Deep vim mode (like VS Code Vim extension) is a full separate project | Monaco's default keybindings are sufficient |
| Mobile / web client | Desktop-only Electron app. Mobile IDE is a different product entirely | Focus on desktop experience |
| IDE theming engine | Use a solid default theme (One Dark Pro or similar). Full theming is a distraction | Ship 2-3 built-in themes, support VS Code theme format if easy |
| Code completion for non-AI | Traditional IntelliSense / language servers. That's a separate product | Monaco provides basic completions. Deep LSP integration is out of scope |

## Feature Dependencies

```
Open Folder (workspace)
  -> File Tree
  -> Tab Editor (Monaco)
    -> Syntax Highlighting (built-in to Monaco)
    -> Cursor Position Tracking

LLM API Integration
  -> Streaming Response
  -> Chat Panel (UI)
    -> Code Block Rendering
    -> One-Click Apply
    -> @-Mentions (needs file tree)
    -> Tool Call Visualization

Agent Loop (LLM + Tool System)
  -> File Read Tool (needs workspace)
  -> File Write Tool (needs workspace)
  -> File Edit Tool (needs workspace)
  -> Bash Tool (needs sandboxing)
  -> Grep/Glob Tool (needs workspace)
  -> Permission System
    -> Tool Approval UI
    -> Checkpoints / Undo (needs git or snapshot)

Chat Panel + Agent Loop
  -> Context-Aware Agent (needs cursor tracking + open files)
  -> Plan Mode (needs agent loop)
  -> Inline Edit / Cmd+K (needs Monaco deep integration)
  -> Tab Completion (needs dedicated model + Monaco deep integration)

Multi-Model Support
  -> Model Selection UI
  -> Per-Task Model Config
```

## Feature Comparison Matrix

How the four major AI coding IDEs compare on key features.

| Feature | Cursor | Windsurf | Copilot (VS Code) | Qoder |
|---------|--------|----------|-------------------|-------|
| **Chat Panel** | Sidebar, Cmd+L | Sidebar, Cmd+L | Chat view | Chat panel |
| **Agent Mode** | Full autonomous | Cascade (full) | Agent mode (2025+) | Agentic chat + quests |
| **Inline Edit** | Cmd+K | Via Cascade | Copilot Edits | Via editor |
| **Tab Completion** | Multi-line, cross-file | Supercomplete | Inline suggestions | "Next" predictions |
| **@-Mentions** | Files, Folders, Code, Docs, Web, Codebase | Code blocks | @workspace, @file | Images, code, dirs |
| **Model Choice** | GPT-4, Claude, Gemini, Grok, custom | GPT-4.1, custom | GPT-4o, Claude, Gemini | Qwen-Coder-Qoder |
| **BYOK** | Yes (own API key) | Enterprise only | No (subscription) | Yes |
| **MCP Support** | Yes | Yes | Yes | Yes |
| **Browser Tool** | Yes | Yes (live preview) | No | No |
| **Sandbox/Terminal** | Full sandbox (macOS, Linux, WSL2) | Terminal tracking | Terminal execution | Terminal |
| **Checkpoints** | Yes (auto-snapshot) | No | No | No |
| **Memories** | No (rules only) | Yes (auto-generated) | Yes (public preview) | Yes (memory + rules) |
| **Rules/Custom Instructions** | .cursorrules | Rules + workflows | Custom instructions | Rules |
| **Plan Mode** | Yes | Via Cascade | Plan agent | Spec-driven dev |
| **Debug Mode** | Yes (v2.2) | No | No | No |
| **Codebase Indexing** | Yes (deep) | Yes (full context) | Workspace search | RepoWiki (100K files) |
| **Multi-Agent** | Yes (v2.0) | Multiple Cascades | Plan + cloud agents | Expert Panel mode |
| **Base Editor** | VS Code fork | Custom (Codeium) | VS Code extension | Custom IDE + JetBrains |
| **Pricing** | $20/mo | Free tier + $15/mo Pro | $10-19/mo | Free tier + paid plans |

## MVP Recommendation

For wzxClaw's MVP (personal AI coding IDE), prioritize:

### Must-Have (Phase 1)
1. **Open folder + file tree + Monaco tabs** -- Without an editor, nothing else matters
2. **Chat panel with streaming** -- Core AI interaction surface
3. **Agent loop with file read/write/edit tools** -- The core value proposition
4. **Bash execution tool** -- Autonomous coding requires running commands
5. **OpenAI-compatible API with BYOK** -- Multi-model support from day one
6. **Tool approval / permission prompts** -- Safety baseline
7. **Code block apply** -- Bridge between chat and editor

### Should-Have (Phase 2)
8. **@-mentions (start with @Files, @Folders)** -- Massive UX upgrade
9. **Grep/Glob tools** -- Agent needs code search for non-trivial tasks
10. **Checkpoints** -- Trust mechanism for autonomous agent
11. **Rules / .wzxclawrules** -- Zero-cost way to improve agent behavior
12. **Conversation history persistence** -- Resume sessions

### Nice-to-Have (Phase 3+)
13. **Inline edit (Cmd+K)** -- Requires deep Monaco integration
14. **Plan mode** -- Structured agent workflow
15. **Tab completion** -- Requires dedicated model or specialized API
16. **MCP support** -- Extensibility story
17. **Codebase indexing** -- Semantic search over project

### Explicitly Defer
- **Tab completion** -- Complex, requires dedicated inference. Every IDE treats this as a separate subsystem
- **Inline edit (Cmd+K)** -- Deep Monaco integration, can be Phase 3
- **Debug mode** -- Requires debugger protocol integration, very complex
- **Browser tool** -- Requires Chromium automation, very complex
- **Cloud agent** -- Requires backend infrastructure
- **Multi-agent** -- Requires orchestration layer

## Sources

- [Cursor Agent Overview](https://cursor.com/docs/agent/overview) -- Official docs, HIGH confidence
- [Cursor Terminal/Sandbox](https://cursor.com/docs/agent/tools/terminal) -- Official docs, HIGH confidence
- [Cursor Inline Edit](https://cursor.com/help/ai-features/inline-edit) -- Official docs, HIGH confidence
- [Cursor Tab Completion](https://cursor.com/help/ai-features/tab) -- Official docs, HIGH confidence
- [Cursor @-Mentions](https://cursor.com/help/customization/context) -- Official docs, HIGH confidence
- [GitHub Copilot Features](https://docs.github.com/en/copilot/get-started/features) -- Official docs, HIGH confidence
- [VS Code Agents Tutorial](https://code.visualstudio.com/docs/copilot/agents/agents-tutorial) -- Official docs, HIGH confidence
- [Windsurf Cascade](https://windsurf.com/cascade) -- Official page, HIGH confidence
- [Qoder Homepage](https://qoder.com/en) -- Official page, HIGH confidence
- [Cursor Deep Dive: $29B by Forking VS Code](https://www.mmntm.net/articles/cursor-deep-dive) -- Analysis, MEDIUM confidence
- [AI Coding Agents in 2025: Comprehensive Comparison](https://kingy.ai/blog/ai-coding-agents-in-2025-cursor-vs-windsurf-vs-copilot-vs-claude-vs-vs-code-ai/) -- Comparison, MEDIUM confidence
- [Cursor vs Claude Code](https://www.devtoolsacademy.com/blog/cursor-vs-claudecode/) -- Comparison, MEDIUM confidence
- [OpenAI Codex Agent Approvals](https://developers.openai.com/codex/agent-approvals-security/) -- Official docs, HIGH confidence
- [AI Agent Sandboxing Guide](https://levelup.gitconnected.com/a-technical-guide-to-ai-agent-sandboxing-dfdf9571dd2d) -- Technical analysis, MEDIUM confidence
