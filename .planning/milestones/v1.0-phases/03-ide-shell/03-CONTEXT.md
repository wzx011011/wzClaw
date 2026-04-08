# Phase 3: IDE Shell - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the desktop IDE shell with code editor, file explorer, and multi-file tab system. This phase delivers:

1. **IDE Layout** — VS Code-style shell with sidebar, tab bar, and editor panel
2. **Monaco Editor** — Code editing with syntax highlighting, multi-tab support
3. **File Explorer** — Directory tree with lazy loading and virtualized rendering
4. **Tab Management** — Dirty tracking, Ctrl+S save, agent edit auto-refresh

No chat panel — that's Phase 4. This phase makes the app a functional code editor.

</domain>

<decisions>
## Implementation Decisions

### IDE Layout & Shell
- **D-41:** VS Code-style layout: sidebar + tab bar + editor panel
- **D-42:** Monaco Editor via @monaco-editor/react for code editing
- **D-43:** Open folder as workspace, watch with chokidar, render tree view
- **D-44:** Resizable split panels for sidebar/editor (react-split-pane or CSS resize)

### File Explorer
- **D-45:** Recursive component rendering for directory tree
- **D-46:** Virtualized list (react-window) for handling 1000+ files
- **D-47:** Lazy loading — load children on expand, not all at once
- **D-48:** Context menu (right-click): open, rename, delete

### Tab & Editor State
- **D-49:** Zustand store for tabs (consistent with stack choice)
- **D-50:** Dirty tracking by comparing editor content vs disk content, show dot indicator
- **D-51:** Ctrl+S writes to disk via IPC to main process
- **D-52:** Agent edits trigger IPC event from main → auto-open/refresh tab with new content

### Theme & Chrome
- **D-53:** VS Code Dark+ default theme (Monaco built-in)
- **D-54:** Electron BrowserWindow with Chromium menu bar
- **D-55:** Bottom status bar: file path, encoding, agent status
- **D-56:** Default OS title bar (no custom frameless bar for MVP)

### Claude's Discretion
- Exact React component hierarchy
- File explorer node rendering details
- Tab bar close/scroll behavior
- Monaco editor configuration options
- IPC channel names for file operations

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/shared/ipc-channels.ts` — Already has `file:open`, `file:save`, `file:changed` IPC stubs from Phase 1 preload
- `src/main/ipc-handlers.ts` — Has settings handlers and agent:send_message wired to AgentLoop
- `src/main/tools/file-read.ts` — FileReadTool can read files (reuse logic for editor)
- `src/main/tools/file-write.ts` — FileWriteTool can write files (reuse logic for save)
- `src/main/tools/file-edit.ts` — FileEditTool with search-and-replace
- `src/shared/constants.ts` — MAX_FILE_READ_LINES already defined
- `src/main/agent/agent-loop.ts` — AgentLoop yields AgentEvents including file change events

### Established Patterns
- IPC via contextBridge — file operations follow same channel pattern
- Zustand for state management — tabs should use Zustand store
- Stream forwarding via sender.send() — file change events follow same pattern

### Integration Points
- Renderer needs IPC channels for: open folder dialog, read directory, read file, save file, watch changes
- File explorer calls main process to read directory tree
- Monaco editor loads file content via IPC, saves via IPC
- Agent file modifications (FileWrite/FileEdit) trigger tab refresh via IPC events

</code_context>

<specifics>
## Specific Ideas

- No specific requirements — Claude has full discretion on component design
- Target a functional IDE first, polish in Phase 5
- Monaco Editor is the core — get it working with tabs and file explorer ASAP

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 03-ide-shell*
*Context gathered: 2026-04-03*
