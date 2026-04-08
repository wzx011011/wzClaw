# Requirements: wzxClaw

**Defined:** 2026-04-08
**Core Value:** AI Agent 能正确调用工具完成编程任务，用户在 IDE 中实时看到过程和结果，具备生产级 AI IDE 的核心体验

## v1.0 Requirements (Complete)

### Agent Runtime

- [x] **AGNT-01**: Agent 能与 LLM 进行多轮对话循环（发送消息 → 接收回复 → 解析工具调用 → 执行工具 → 反馈结果 → 循环）
- [x] **AGNT-02**: Agent 支持流式输出，实时将 LLM 响应推送到 UI
- [x] **AGNT-03**: Agent 支持 tool_use 响应解析，能识别 LLM 请求的工具调用并执行
- [x] **AGNT-04**: Agent 有上下文窗口管理，能追踪 token 用量并在接近限制时自动截断/压缩
- [x] **AGNT-05**: Agent 有无限循环防护，检测重复工具调用并强制停止
- [x] **AGNT-06**: Agent 支持中途取消（AbortController），用户可停止正在进行的生成

### Tool System (v1.0)

- [x] **TOOL-01**: FileRead 工具 — 读取指定文件内容，返回带行号的文本
- [x] **TOOL-02**: FileWrite 工具 — 创建或覆盖文件
- [x] **TOOL-03**: FileEdit 工具 — 基于搜索替换的精确编辑（old_string → new_string），防止竞态条件
- [x] **TOOL-04**: Bash 工具 — 执行 shell 命令，支持超时（默认 120s），流式输出 stdout/stderr
- [x] **TOOL-05**: Grep 工具 — 正则表达式搜索文件内容，返回匹配行
- [x] **TOOL-06**: Glob 工具 — 按文件名模式搜索文件路径
- [x] **TOOL-07**: 工具调用可视化 — 在 Chat 中显示 Agent 调用了什么工具，输入参数和输出结果
- [x] **TOOL-08**: 工具权限系统 — 破坏性操作（文件写入、Bash 执行）需用户确认；只读操作可自动允许

### Chat Panel (v1.0)

- [x] **CHAT-01**: 侧边栏聊天面板，可调整大小、可折叠
- [x] **CHAT-02**: 流式响应显示 — 逐 token 实时渲染 LLM 输出
- [x] **CHAT-03**: 代码块渲染 — 语法高亮 + 一键复制 + "Apply"按钮将代码插入编辑器
- [x] **CHAT-04**: Markdown 渲染 — 支持标题、列表、粗体、链接、表格
- [x] **CHAT-05**: 会话内消息历史 — 显示完整的对话记录（用户消息、助手回复、工具结果）
- [x] **CHAT-06**: 中途停止生成 — 用户可取消正在进行的响应
- [x] **CHAT-07**: 清空/重置对话 — 用户可开始新的对话

### LLM Integration (v1.0)

- [x] **LLM-01**: 支持 OpenAI 兼容 API（覆盖 OpenAI、DeepSeek 及其他兼容端点）
- [x] **LLM-02**: 支持 Anthropic API（Claude 模型）
- [x] **LLM-03**: API Key 配置界面 — 用户可输入并保存多个 Provider 的 API Key
- [x] **LLM-04**: 模型选择/切换 — 用户可在对话中切换使用不同模型
- [x] **LLM-05**: 流式响应处理 — SSE 流式接收 LLM 输出
- [x] **LLM-06**: System Prompt 支持 — 可配置的系统提示词

### Editor (v1.0)

- [x] **EDIT-01**: Monaco Editor 集成 — 代码编辑器，支持语法高亮
- [x] **EDIT-02**: Tab 多文件编辑 — 同时打开多个文件
- [x] **EDIT-03**: 文件树（Explorer）— 目录树视图，展示工作区文件结构
- [x] **EDIT-04**: 打开文件夹作为工作区 — 通过对话框选择项目根目录
- [x] **EDIT-05**: Agent 编辑文件后自动打开对应 Tab
- [x] **EDIT-06**: 文件保存和脏状态追踪

### Electron Shell (v1.0)

- [x] **ELEC-01**: Electron 桌面应用窗口，包含菜单栏和状态栏
- [x] **ELEC-02**: IPC 通信桥接 — Main Process 和 Renderer Process 之间的类型安全通信
- [x] **ELEC-03**: 应用打包和分发（electron-builder）

## v1.2 Requirements

### Context Management (CTX)

- [x] **CTX-01**: Agent loop tracks token usage per conversation turn (input + output tokens from API usage)
- [x] **CTX-02**: Token counting via js-tiktoken before each LLM call to estimate context utilization
- [x] **CTX-03**: Auto-compact triggers when conversation exceeds 80% of model context window, summarizing older messages into a condensed form
- [x] **CTX-04**: Compact only occurs between LLM turns, never during active tool execution (circuit breaker pattern)
- [x] **CTX-05**: User can manually trigger compact via a command (e.g., /compact in chat)
- [x] **CTX-06**: Context window size is configurable per model in settings (default: 128K for GLM, 200K for Claude)
- [x] **CTX-07**: Tool results are truncated to MAX_TOOL_RESULT_CHARS before adding to context

### Inline Diff Preview (DIFF)

- [ ] **DIFF-01**: When AI proposes file changes via FileWrite/FileEdit, a diff preview is shown instead of immediately writing to disk
- [ ] **DIFF-02**: Diff uses Monaco decorations API to overlay colored lines on the active editor (green for additions, red for deletions)
- [ ] **DIFF-03**: User can accept or reject each diff hunk individually
- [ ] **DIFF-04**: User can accept all or reject all changes via toolbar buttons (Ctrl+Enter / Ctrl+Backspace)
- [ ] **DIFF-05**: Multi-file changes show a file list navigator to review each file's changes
- [ ] **DIFF-06**: Rejected hunks are not written to disk; accepted hunks are applied immediately
- [ ] **DIFF-07**: Diff preview state is tracked per file — user cannot edit file while diff is pending

### @-mention Context (MENTION)

- [x] **MENTION-01**: User can type @ in chat input to open a context picker showing files and folders from the current workspace
- [x] **MENTION-02**: Selecting a file injects its content (up to 500 lines) into the conversation context with file path header
- [x] **MENTION-03**: Selecting a folder injects a directory tree summary into the context
- [x] **MENTION-04**: Multiple @-mentions can be included in a single message
- [x] **MENTION-05**: @-mention picker supports fuzzy search to quickly find files by name
- [x] **MENTION-06**: Injected file content is visible in the chat message as collapsible context blocks

### Multi-session Management (SESSION)

- [ ] **SESSION-01**: User can open multiple chat sessions as tabs in the chat panel
- [ ] **SESSION-02**: Each session has independent conversation history, agent loop state, and context
- [ ] **SESSION-03**: User can switch between sessions without losing state in any session
- [ ] **SESSION-04**: User can create a new session via button or keyboard shortcut
- [ ] **SESSION-05**: User can delete a session, with confirmation dialog
- [ ] **SESSION-06**: Session list shows session title (auto-generated from first message) and creation time
- [ ] **SESSION-07**: Only the active session's agent loop is "hot" — inactive sessions are lazy-loaded from persistence

### Command Palette (CMD)

- [x] **CMD-01**: Ctrl+Shift+P opens a command palette overlay with fuzzy search
- [x] **CMD-02**: Commands are registered with name, category, shortcut, and handler function
- [x] **CMD-03**: Built-in commands include: open file, open folder, new session, clear session, toggle terminal, toggle sidebar, change model, settings
- [x] **CMD-04**: Command palette shows keyboard shortcuts next to command names where applicable
- [x] **CMD-05**: Plugin system allows future registration of custom commands

### Terminal Panel (TERM)

- [ ] **TERM-01**: A terminal panel is available at the bottom of the IDE layout, toggleable via button or command
- [ ] **TERM-02**: Terminal uses xterm.js for rendering and node-pty for PTY backend (same stack as VS Code)
- [ ] **TERM-03**: User can type and execute commands in the terminal interactively
- [ ] **TERM-04**: Multiple terminal instances can be opened as tabs within the terminal panel
- [ ] **TERM-05**: Agent Bash tool can optionally route command execution through the terminal panel for visibility
- [ ] **TERM-06**: Terminal output is captured and available to the agent for analysis (e.g., error diagnosis)
- [ ] **TERM-07**: Terminal working directory syncs with the current workspace root

### More Tools (TOOLv2)

- [x] **TOOL-09**: WebSearch tool — agent can search the web for information, with domain filtering
- [x] **TOOL-10**: WebFetch tool — agent can fetch and read web pages, converting to markdown
- [x] **TOOL-11**: LSP Symbol Navigation — agent can find symbol definitions and references using Monaco's built-in JS/TS support
- [ ] **TOOL-12**: LSP client infrastructure for future integration with external language servers
- [ ] **TOOL-13**: NotebookEdit tool — agent can edit Jupyter notebook cells (.ipynb files)

### Codebase Indexing (IDX)

- [ ] **IDX-01**: Project files are indexed in the background using embedding vectors for semantic search
- [ ] **IDX-02**: Indexing uses file-level embeddings via the configured LLM API (e.g., OpenAI text-embedding-3-small)
- [ ] **IDX-03**: Vector storage uses sql.js with sqlite-vec extension (WASM, no native dependency)
- [ ] **IDX-04**: Index is built incrementally — only new/modified files are re-indexed on file change
- [ ] **IDX-05**: Agent can perform semantic search across the codebase to find relevant code
- [ ] **IDX-06**: Indexing status is shown in the status bar (indexing/ready/error + file count)
- [ ] **IDX-07**: User can trigger manual re-index via command palette
- [ ] **IDX-08**: Large files (>100KB) and binary files are excluded from indexing

### Session Persistence (PERSIST)

- [x] **PERSIST-01**: Chat sessions are persisted to disk as JSONL files (one JSON object per line, append-only)
- [x] **PERSIST-02**: Sessions are auto-saved after each agent turn completes
- [x] **PERSIST-03**: On app restart, previous sessions are loaded and visible in the session list
- [x] **PERSIST-04**: Session restoration recovers messages, tool calls, and usage metadata
- [x] **PERSIST-05**: Corrupted/malformed lines in JSONL are skipped gracefully without losing the rest of the session
- [x] **PERSIST-06**: Sessions are stored per-project in userData/sessions/{project-hash}/

### Task/Plan System (TASK)

- [ ] **TASK-01**: Agent can create tasks with subject, description, and status (pending/in_progress/completed)
- [ ] **TASK-02**: Tasks support dependencies (blockedBy/blocks) — a task cannot start until its blockers are resolved
- [ ] **TASK-03**: Tasks are displayed in a task list panel, filterable by status
- [ ] **TASK-04**: Agent updates task status as it works through them
- [ ] **TASK-05**: User can view task progress in real-time as the agent works

## v2 Requirements (Deferred)

### Inline AI Editing
- **INLINE-01**: Tab completion (ghost text suggestions) — requires FIM model inference
- **INLINE-02**: Ctrl+K inline edit (select code → AI rewrite) — requires diff application in editor

### Advanced Agent
- **AGENT-01**: Subagent spawning (parallel agents with memory isolation)
- **AGENT-02**: MCP protocol support (external tool servers)
- **AGENT-03**: Hooks system (pre/post tool execution scripts)

### Collaboration
- **COLLAB-01**: Export conversation as Markdown
- **COLLAB-02**: Cloud agent (remote execution)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Tab completion (ghost text) | Requires dedicated FIM model + inference optimization — defer to v2 |
| Ctrl+K inline edit | Complex editor integration, depends on inline diff first — defer to v2 |
| MCP protocol | Complex external server management — defer to v2 |
| Hooks system | Script execution lifecycle management — defer to v2 |
| Subagent spawning | Architecture complexity, memory isolation — defer to v2 |
| VS Code extension compatibility | Not a VS Code fork, incompatible extension API |
| Debug mode | Runtime instrumentation — defer to v3 |
| Visual editor | Drag-and-drop UI design — defer to v3 |
| Cloud agent | Remote execution infrastructure — not applicable for personal tool |
| Voice input | Hardware dependency, niche use case — defer to v3 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AGNT-01 through AGNT-06 | Phase 2: Agent Core | Complete |
| TOOL-01 through TOOL-08 | Phase 2: Agent Core | Complete |
| CHAT-01 through CHAT-07 | Phase 4: Chat Panel | Complete |
| LLM-01 through LLM-06 | Phase 1: Foundation | Complete |
| EDIT-01 through EDIT-06 | Phase 3: IDE Shell | Complete |
| ELEC-01 through ELEC-03 | Phase 3/5 | Complete |
| CTX-01 through CTX-07 | Phase 6: Foundation Upgrades | Complete |
| DIFF-01 through DIFF-07 | Phase 7: Core Interaction | Pending |
| MENTION-01 through MENTION-06 | Phase 7: Core Interaction | Pending |
| SESSION-01 through SESSION-07 | Phase 7: Core Interaction | Pending |
| CMD-01 through CMD-05 | Phase 6: Foundation Upgrades | Pending |
| TERM-01 through TERM-07 | Phase 8: Advanced Features | Pending |
| TOOL-09 through TOOL-13 | Phase 8: Advanced Features | Pending |
| IDX-01 through IDX-08 | Phase 9: Codebase Indexing | Pending |
| PERSIST-01 through PERSIST-06 | Phase 6: Foundation Upgrades | Pending |
| TASK-01 through TASK-05 | Phase 8: Advanced Features | Pending |

**Coverage:**
- v1.0 requirements: 33 total -- all Complete
- v1.2 requirements: 63 total
- Mapped to phases: 63
- Unmapped: 0

**Coverage Map (v1.2):**

| Phase | Requirements | Count |
|-------|-------------|-------|
| Phase 6: Foundation Upgrades | CTX-01..07, CMD-01..05, PERSIST-01..06 | 18 |
| Phase 7: Core Interaction | SESSION-01..07, MENTION-01..06, DIFF-01..07 | 20 |
| Phase 8: Advanced Features | TERM-01..07, TOOL-09..13, TASK-01..05 | 17 |
| Phase 9: Codebase Indexing | IDX-01..08 | 8 |
| **Total** | | **63** |

---
*Requirements defined: 2026-04-03*
*Last updated: 2026-04-08 -- v1.2 roadmap created, traceability updated*
