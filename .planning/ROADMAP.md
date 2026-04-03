# Roadmap: wzxClaw

## Overview

Build a Cursor-like AI coding IDE desktop application, starting from the foundation layer (shared types, IPC protocol, LLM Gateway) and building upward through the Agent Core (conversation loop + tool system), then the IDE Shell (Electron + Monaco + file explorer), then wiring everything together through a Chat Panel, and finally packaging for distribution. Each phase delivers a coherent, independently verifiable capability.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation** - Shared types, IPC protocol, and LLM Gateway with multi-provider streaming
- [ ] **Phase 2: Agent Core** - Agent Runtime conversation loop, Tool System (6 tools), and permission model
- [ ] **Phase 3: IDE Shell** - Electron app window, Monaco Editor integration, file explorer, and workspace management
- [x] **Phase 4: Chat Panel + Integration** - Chat UI, tool call visualization, settings panel, and end-to-end wiring (completed 2026-04-03)
- [ ] **Phase 5: Polish + Packaging** - Application packaging, final integration testing, and distribution

## Phase Details

### Phase 1: Foundation
**Goal**: The LLM Gateway can stream responses from OpenAI-compatible and Anthropic APIs through a unified interface, and Main/Renderer processes can communicate via typed IPC channels
**Depends on**: Nothing (first phase)
**Requirements**: LLM-01, LLM-02, LLM-05, LLM-06, ELEC-02
**Success Criteria** (what must be TRUE):
  1. Given a valid API key, the LLM Gateway can stream a text response from an OpenAI-compatible endpoint (OpenAI, DeepSeek) and deliver tokens as they arrive
  2. Given a valid API key, the LLM Gateway can stream a text response from the Anthropic Claude API and deliver tokens as they arrive
  3. A configurable system prompt is included in all LLM requests
  4. Main process and renderer process can exchange typed messages through IPC channels without runtime type errors
  5. Shared TypeScript type definitions compile without errors and are importable from both main and renderer process code
**Plans**: 3 plans

Plans:
- [x] 01-01: TBD
- [x] 01-02: TBD
- [x] 01-03: TBD

### Phase 2: Agent Core
**Goal**: An Agent Runtime can autonomously drive multi-turn LLM conversations with tool execution, safely handling file operations, command execution, and code search with user-controlled permissions
**Depends on**: Phase 1
**Requirements**: AGNT-01, AGNT-02, AGNT-03, AGNT-04, AGNT-05, AGNT-06, TOOL-01, TOOL-02, TOOL-03, TOOL-04, TOOL-05, TOOL-06, TOOL-08
**Success Criteria** (what must be TRUE):
  1. The agent can complete a multi-turn conversation loop: send a user message, receive an LLM response with a tool call, execute the tool, feed the result back, and receive a final text response
  2. All 6 tools (FileRead, FileWrite, FileEdit, Bash, Grep, Glob) execute their operations correctly and return structured results
  3. FileEdit uses search-and-replace (old_string/new_string) and rejects edits when the old string no longer matches the file (race condition protection)
  4. Destructive operations (FileWrite, FileEdit, Bash) prompt for user approval before executing; read-only operations (FileRead, Grep, Glob) execute automatically
  5. The agent stops after detecting repeated identical tool calls (3+ consecutive) and caps total tool iterations per turn at 25
  6. An in-progress agent conversation can be cancelled mid-stream and cleanly terminates all pending operations
**Plans**: 4 plans

Plans:
- [x] 02-01-PLAN.md — Tool interface + read-only tools (FileRead, Grep, Glob) + tool registry
- [x] 02-02-PLAN.md — Destructive tools (FileWrite, FileEdit, Bash) + PermissionManager + IPC permission channels
- [x] 02-03-PLAN.md — Agent loop with LoopDetector, MessageBuilder, tool execution, cancellation, and safety guards
- [x] 02-04-PLAN.md — IPC integration wiring AgentLoop into main process entry point

### Phase 3: IDE Shell
**Goal**: Users have a desktop IDE window with a code editor, file explorer, and multi-file tab system for opening and editing project files
**Depends on**: Phase 1
**Requirements**: ELEC-01, EDIT-01, EDIT-02, EDIT-03, EDIT-04, EDIT-05, EDIT-06
**Success Criteria** (what must be TRUE):
  1. The application launches as a desktop window with a menu bar and status bar
  2. User can open a folder as a workspace and see the directory tree in a file explorer sidebar
  3. User can open files from the explorer into Monaco Editor tabs, edit content, and see syntax highlighting
  4. User can save files (Ctrl+S), and the editor tracks dirty/modified state with visual indicators
  5. When the agent modifies a file (via FileWrite or FileEdit), the corresponding editor tab opens or refreshes automatically
**Plans**: 3 plans

Plans:
- [x] 03-01-PLAN.md — Main process workspace management (WorkspaceManager, IPC handlers, chokidar watch, menu bar)
- [x] 03-02-PLAN.md — Renderer IDE layout (Monaco Editor, file explorer, tab bar, Zustand stores)
- [x] 03-03-PLAN.md — Agent integration (Ctrl+S save, dirty tracking, agent edit auto-refresh, status bar)

### Phase 4: Chat Panel + Integration
**Goal**: Users interact with the AI agent through a sidebar chat panel, see streaming responses with tool call visualizations, configure API keys and models, and apply AI-generated code directly into the editor
**Depends on**: Phase 1, Phase 2, Phase 3
**Requirements**: CHAT-01, CHAT-02, CHAT-03, CHAT-04, CHAT-05, CHAT-06, CHAT-07, TOOL-07, LLM-03, LLM-04
**Success Criteria** (what must be TRUE):
  1. User can type a message in the chat panel and see the LLM response stream in token-by-token
  2. When the agent calls a tool, the chat panel displays the tool name, input parameters, and output result in a readable format
  3. Code blocks in chat responses render with syntax highlighting and have an "Apply" button that inserts the code into the active editor tab
  4. User can input and save API keys for multiple providers (OpenAI-compatible, Anthropic) through a settings panel, and switch between models during a conversation
  5. User can stop an in-progress generation and clear/reset the conversation to start fresh
**Plans**: 3 plans
**UI hint**: yes

Plans:
- [x] 04-01-PLAN.md — Chat store + settings store + IDELayout three-pane integration + npm dependencies
- [x] 04-02-PLAN.md — Chat panel UI (ChatPanel, ChatMessage, CodeBlock, ToolCard, PermissionRequest) with markdown + syntax highlighting + Apply button
- [x] 04-03-PLAN.md — SettingsManager with safeStorage + SettingsModal + model selector in chat header

### Phase 5: Polish + Packaging
**Goal**: The application is packaged as an installable desktop application and passes end-to-end integration testing across all features
**Depends on**: Phase 4
**Requirements**: ELEC-03
**Success Criteria** (what must be TRUE):
  1. The application builds as a packaged installer (or portable executable) that launches without a development environment
  2. End-to-end workflow works in the packaged build: open workspace, send chat message, agent executes tools, apply code to editor, save file
**Plans**: 2 plans

Plans:
- [x] 05-01-PLAN.md — electron-builder NSIS config + app icon + build verification
- [x] 05-02-PLAN.md — Full NSIS installer build + human E2E workflow verification

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 3/3 | Complete | 2026-04-03 |
| 2. Agent Core | 0/4 | Planning complete | - |
| 3. IDE Shell | 2/3 | In Progress|  |
| 4. Chat Panel + Integration | 0/3 | Complete    | 2026-04-03 |
| 5. Polish + Packaging | 0/2 | Planning complete | - |
