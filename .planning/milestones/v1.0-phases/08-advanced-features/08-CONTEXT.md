# Phase 8: Advanced Features - Context

**Gathered:** 2026-04-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Users have a fully interactive terminal panel, the agent can search the web and navigate code symbols, and tasks can be created and tracked during agent execution. This phase adds 4 new capability areas: terminal (xterm.js + node-pty), web search/fetch tools, code symbol navigation, and a task management system.

</domain>

<decisions>
## Implementation Decisions

### Terminal Panel Architecture
- xterm.js + node-pty installed via npm, @electron/rebuild added to build script (per v2-PIT-01)
- TerminalManager singleton — Bash tool writes to PTY when terminal panel is open, falls back to child_process when closed
- Capture PTY data stream, buffer last N bytes, expose via IPC when agent requests terminal output
- Multi-terminal tab management using SessionTabs pattern from Phase 7 (Zustand store with tabs, create/switch/close)

### Web Search & Fetch Tools
- Support configurable search: LLM built-in web search if available, fallback to manual API key (Brave/SerpAPI)
- Truncate web content at 15000 chars with link preserved, convert HTML to readable markdown
- Rate limiting: 1 request/3 seconds default, configurable via settings
- Graceful error handling with status code and first 500 chars of response body

### Code Symbol Navigation
- Monaco runs in renderer — IPC channel for symbol queries, renderer queries TypeScriptWorker and returns structured results
- 3 symbol operations: GoToDefinition, FindReferences, SearchSymbols
- Structured JSON result format: file path, line number, symbol name, kind (function/class/variable)

### Task/Plan System
- Task list panel as collapsible panel below chat in sidebar (togglable via tab)
- Agent has createTask/updateTask tools, TaskManager in main process with events streamed to renderer
- Simple blockedBy array for dependencies — circular dependency detection included
- Real-time progress via store subscription, status badges and progress bar

### Claude's Discretion
- xterm.js addon selection (fit-addon, web-links-addon, etc.)
- PTY data buffer size for agent analysis
- Search result ranking and relevance filtering
- Task panel visual design (icons, colors, animations)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- SessionTabs component pattern (Phase 07) — reusable for terminal tabs
- Tool registry system (Phase 02) — new tools register here
- IPC channel pattern (Phase 01) — new channels follow same Zod validation pattern
- Zustand store pattern — used for all state (chat, diff, sessions, commands)
- Chat panel layout — sidebar with collapsible sections

### Established Patterns
- Tools implement ITool interface with execute() method in src/main/tools/
- IPC channels defined in src/shared/ipc-channels.ts with Zod schemas
- Stores in src/renderer/stores/ with Zustand
- Components in src/renderer/components/ grouped by area (chat/, ide/)
- Styles in src/renderer/styles/ per component area

### Integration Points
- Tool registry: src/main/tools/tool-registry.ts — new tools register here
- Agent loop: src/main/agent/ — new tools wired into agent
- IPC preload: src/preload/index.ts — new channels exposed here
- IDE layout: src/renderer/components/ide/IDELayout.tsx — terminal panel integration
- Chat panel: src/renderer/components/chat/ChatPanel.tsx — task panel integration

</code_context>

<specifics>
## Specific Ideas

- Terminal panel should be resizable (like VS Code terminal panel drag handle)
- Terminal tabs should show active process name (like bash, node, etc.)
- Web search results should show source URLs for verification
- Task panel should show estimated vs actual task counts like progress tracking

</specifics>

<deferred>
## Deferred Ideas

- NotebookEdit tool (TOOL-13) — low priority for personal use, defer to future phase
- External LSP server integration (TOOL-12) — defer until core symbol nav works with built-in TS support
- Terminal shell integration (PowerShell, WSL profiles) — basic shell only for MVP

</deferred>
