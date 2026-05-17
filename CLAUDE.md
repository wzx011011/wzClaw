# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Structure

This is a monorepo for wzxClaw — a personal AI coding IDE (similar to Cursor). It contains:

- **`wzxClaw_desktop/`** — Electron desktop app (the IDE itself)
- **`packages/brain/`** — AgentLoop + LLM Gateway + Context（独立 Node.js 包）
- **`packages/agent-server/`** — NAS WebSocket 服务器（Brain runtime + Hand 路由）
- **`packages/hand/`** — 可插拔工具执行器（npm 包，`npx wzxclaw-hand` 启动）
- **`packages/web-ui/`** — 共享 React SPA（Electron renderer + 远程 WebSocket）
- **`relay/`** — Node.js WebSocket relay service deployed on the NAS
- **`wzxClaw_android/`** — ~~Flutter Android~~ **DEPRECATED** — 已迁移到 Capacitor + web-ui

Both share a single Git repository. The desktop project is the primary codebase.

## Packaging (One-Command Builds)

**桌面端 Windows 安装包**（先关闭正在运行的 wzxClaw.exe）：

```bash
cd wzxClaw_desktop && npm run build:win
# 产物: dist/wzxClaw Setup 0.1.0.exe (~102 MB)
```

**Android APK**（已弃用 Flutter，新方案见 packages/web-ui + Capacitor）：

~~Flutter APK~~ — 已迁移到 Capacitor + web-ui 方案。

---

## Packages (monorepo)

### packages/brain/ — AgentLoop + LLM Gateway + Context

独立 Node.js 包，无 Electron 依赖。核心模块：

- `agent/` — AgentLoop, TurnManager, StreamPhase, ConversationManager
- `llm/` — LLMGateway, OpenAI/Anthropic adapters, CostTracker
- `context/` — ContextManager, token counting, compaction, tool result budget
- `hooks/` — HookRegistry + built-in hooks
- `observability/` — LangfuseObserver (console fallback)
- `permission/` — PermissionManager (4 modes)

```bash
cd packages/brain && npm run build && npm test   # 27 tests
```

### packages/agent-server/ — NAS WebSocket 服务器

HTTP + WebSocket 服务器，部署在 NAS Docker。支持 client 和 hand 双通道 WebSocket 连接。

- `server.ts` — HTTP /health + /admin API + WebSocket 服务器
- `client-handler.ts` — 客户端连接处理 + AgentLoop 桥接
- `hands-router.ts` — Hand 注册/路由/心跳管理
- `hand-aware-tool-executor.ts` — 基于 Hand 的工具执行
- `session-sqlite.ts` — SQLite 会话持久化
- `instructions/` — System prompt builder

```bash
cd packages/agent-server && npm run build && npm test   # 53 core tests
```

### packages/hand/ — 可插拔工具执行器

npm 包，任何机器 `npx wzxclaw-hand` 注册为 Brain 的 Hand。

- `src/connection.ts` — WebSocket 连接管理（注册/心跳/重连）
- `src/tools/` — FileRead/FileWrite/FileList/ShellExecute/Echo
- `src/cli.ts` — parseArgs CLI 入口

```bash
cd packages/hand && npm run build && npm test   # 55 tests
```

### packages/web-ui/ — 共享 React SPA

Electron renderer 和远程 WebSocket 共用 UI。

- `data-source/` — DataSource 抽象接口 + IpcDataSource + WebSocketDataSource
- `components/chat/` — ChatPanel, MessageList, ChatMessage
- `components/ide/` — IDELayout, FileExplorer, EditorPanel, TerminalPanel (capability-driven)
- `stores/` — chat-store, layout-store, terminal-store, tab-store
- `hooks/` — useCapabilities, useConnectionConfig

```bash
cd packages/web-ui && npm run dev && npm test   # 45 tests
```

---

## Desktop (wzxClaw_desktop/)

### Commands

```bash
cd wzxClaw_desktop

# Dev (must run outside VS Code/Cursor terminal — see note below)
npm run dev

# Build Windows installer
npm run build:win

# Tests
npm test                    # vitest run (node env, src/**/*.test.ts)
npm run test:watch          # vitest --watch

# Run a single test file
npx vitest run src/main/agent/__tests__/agent-loop.test.ts

# Eval benchmarks
npm run eval:run
```

**Important:** `npm run dev` cannot run inside VS Code/Cursor's built-in terminal — it inherits `ELECTRON_RUN_AS_NODE=1` which breaks the Electron subprocess. The `scripts/dev.js` launcher clears this env var automatically.

### Architecture

Electron three-process model:

```
Main Process (Node.js)  ←——IPC——→  Preload (contextBridge)  ←——window.wzxclaw——→  Renderer (React)
```

**Main process** (`src/main/index.ts`, 1000+ lines) is the hub — owns BrowserWindow, initializes all services, registers IPC handlers, and dispatches mobile relay messages. Key subsystems:

| Subsystem     | Path                                 | Role                                                                                                                  |
| ------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Agent Loop    | `agent/agent-loop.ts`                | AsyncGenerator-based multi-turn LLM conversation (max 25 turns, 80% context threshold triggers compaction)            |
| Turn Manager  | `agent/turn-manager.ts`              | Single turn lifecycle: stream → accumulate tool calls → execute → yield events                                        |
| Stream Phase  | `agent/stream-phase.ts`              | Consumes LLM stream, fires read-only tools in parallel during streaming                                               |
| LLM Gateway   | `llm/gateway.ts`                     | Routes by model name to OpenAI or Anthropic adapter. GLM-5 series routes through Anthropic adapter (compatible API)   |
| Tool Registry | `tools/tool-registry.ts`             | `createDefaultTools()` factory registers 25+ tools. Each tool implements `Tool` interface (`tools/tool-interface.ts`) |
| Permission    | `permission/`                        | 4 modes: always-ask, accept-edits, plan, bypass. Session-scoped approval caching                                      |
| Sessions      | `persistence/session-store.ts`       | JSONL files per session, isolated by workspace hash                                                                   |
| Context       | `context/`                           | Token counting, auto-compaction, tool result budget truncation, turn attachments                                      |
| MCP           | `mcp/`                               | stdio transport MCP client, tools prefixed `mcp_{serverName}_`                                                        |
| Mobile        | `mobile/relay-client.ts`             | WebSocket tunnel to relay server for Android companion                                                                |
| Observability | `observability/langfuse-observer.ts` | Langfuse tracing (traces, generations, tool spans)                                                                    |

**Renderer** (`src/renderer/`) — React 19 + Zustand 5 + Monaco Editor + xterm.js. 11 Zustand stores in `stores/`, with `chat-store.ts` as the core. App.tsx conditionally renders TaskHomePage, TaskDetailPage, or IDELayout.

**Shared** (`src/shared/`) — Cross-process types and constants:

- `types.ts` — Message types, content blocks, tool calls, stream events
- `ipc-channels.ts` — All ~80 IPC channel names + request/response/stream payload types + Zod schemas
- `constants.ts` — Model presets (11 models), limits, default system prompt, cache boundaries

### Key Conventions

- **IPC channels** are centrally defined in `shared/ipc-channels.ts`. All new channels must be registered there.
- **`@shared` alias** resolves to `src/shared` in all three processes (main, preload, renderer). Renderer also has `@renderer`.
- **Agent events** flow as `AsyncGenerator<AgentEvent>` — never change to callback or Promise patterns.
- **Tool classes** implement `Tool` interface from `tools/tool-interface.ts`, registered via `ToolRegistry`.
- **Code comments** are in Chinese.
- **Renderer state** uses Zustand stores — no React Context for app state.
- **Tests** use vitest in node environment with no Electron dependency. Agent loops use mock generators.
- **WZXCLAW.md** files in project roots are loaded by `instruction-loader.ts` into the system prompt.
- **Session storage**: `%APPDATA%/wzxclaw/sessions/{sha256-16}/{session-id}.jsonl`
- **User-level data**: `~/.wzxclaw/` (commands/, skills/, memory/, mcp.json, cache/, debug/, etc.)
- **Prompt caching**: Anthropic adapter uses 3-level cache (static prompt, tool defs, conversation history)

### Prompt Cache Boundaries

The system prompt is split by cache markers:

1. `SYSTEM_PROMPT_CACHE_BOUNDARY` — static content (base prompt + tool defs) vs dynamic (env info, git context, instructions, memory)
2. `TOOL_DEFS_CACHE_BOUNDARY` — separates tool definitions from dynamic context

---

## ~~Android (wzxClaw_android/)~~ — DEPRECATED

> Flutter Android 项目已弃用，手机端迁移到 Capacitor + web-ui 方案。
> 新架构：**Phone** ← WSS → **NAS agent-server** (packages/agent-server/)，不再经过桌面端中转。
> 详见 `.planning/ROADMAP.md` Phase 6/14。

### Relay Server (relay/)

- `server.js` — HTTP + WebSocket server, token auth, room management
- `lib/room.js` — RoomManager: token-keyed rooms, desktop↔mobile routing, offline queues, 30s health pings
- `lib/auth.js` — Timing-safe token comparison, dev mode fallback
- Docker deployment on NAS at `127.0.0.1:8081`, nginx reverse proxy at `wss://5945.top/relay/`

### Relay Server (relay/)

- `server.js` — HTTP + WebSocket server, token auth, room management
- `lib/room.js` — RoomManager: token-keyed rooms, desktop↔mobile routing, offline queues, 30s health pings
- `lib/auth.js` — Timing-safe token comparison, dev mode fallback
- Docker deployment on NAS at `127.0.0.1:8081`, nginx reverse proxy at `wss://5945.top/relay/`

---

## External Services

- **Langfuse** (observability): `http://192.168.100.78:3000` — NAS Docker, traces agent sessions
- **NAS Relay**: `wss://5945.top/relay/` — nginx reverse proxy to Docker container on port 8081
- **LLM APIs**: Configured per-session in settings. GLM via `open.bigmodel.cn`, DeepSeek via `api.deepseek.com`, OpenAI via `api.openai.com`, Anthropic via `api.anthropic.com`
