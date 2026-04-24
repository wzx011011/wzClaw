# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Structure

This is a monorepo for wzxClaw — a personal AI coding IDE (similar to Cursor). It contains three top-level code areas:

- **`wzxClaw_desktop/`** — Electron desktop app (the IDE itself)
- **`wzxClaw_android/`** — Flutter Android companion app (remote control client)
- **`relay/`** — Node.js WebSocket relay service deployed on the NAS

Both share a single Git repository. The desktop project is the primary codebase.

## Packaging (One-Command Builds)

**桌面端 Windows 安装包**（先关闭正在运行的 wzxClaw.exe）：

```bash
cd wzxClaw_desktop && npm run build:win
# 产物: dist/wzxClaw Setup 0.1.0.exe (~102 MB)
```

**Android APK**：

```bash
cd wzxClaw_android && build_apk.bat
# 或 bash: export JAVA_HOME="/c/Users/67376/jdk17/jdk-17.0.18+8" && /c/Users/67376/flutter/bin/flutter build apk --release
# 产物: build/app/outputs/flutter-apk/app-release.apk (~69 MB)
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

## Android (wzxClaw_android/)

### Commands

```bash
cd wzxClaw_android

# Build APK (requires JAVA_HOME set to JDK 17)
export JAVA_HOME="/c/Users/67376/jdk17/jdk-17.0.18+8"
export PATH="$JAVA_HOME/bin:$PATH"
/c/Users/67376/flutter/bin/flutter build apk --release

# Or use the batch script (Windows)
build_apk.bat

# Analyze
/c/Users/67376/flutter/bin/flutter analyze

# Output: build/app/outputs/flutter-apk/app-release.apk
```

### Architecture

**Phone** ← WSS → **NAS Relay** ← WS/WSS → **Desktop wzxClaw**

The relay server (`relay/`) is a root-level Node.js WebSocket service deployed in Docker on the NAS, exposed via nginx at `wss://5945.top/relay/`. It routes messages between desktop and mobile clients in token-keyed rooms with offline queueing (24h TTL).

**Flutter app structure** (`lib/`):

| Layer    | Files                                                                                                                    | Pattern                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Services | `connection_manager.dart`, `chat_store.dart`, `session_sync_service.dart`, `task_service.dart`, `file_sync_service.dart` | Singletons with `StreamController.broadcast()` |
| Models   | `ws_message.dart`, `chat_message.dart`, `session_meta.dart`, `task_model.dart`                                           | Immutable data classes                         |
| Pages    | `home_page.dart`, `settings_page.dart`, `file_browser_page.dart`, `file_viewer_page.dart`                                | StatefulWidget                                 |
| Widgets  | 15+ widgets                                                                                                              | StreamBuilder-based reactive UI                |
| Config   | `app_config.dart`, `app_colors.dart`                                                                                     | Constants and theme                            |

No external state management library — state flows from singleton services through Dart streams to `StreamBuilder` widgets. `SharedPreferences` for persisted settings.

**WebSocket protocol**: All messages are JSON `{ "event": "...", "data": ... }`. Event names in `WsEvents` class. Key flows:

- `command:send` → `stream:agent:text/tool_call/tool_result/done` (chat)
- `session:list/load/create/delete/rename` (session CRUD proxied to desktop)
- `task:list/get/create/update/delete` (task management)
- `system:desktop_list/target:confirmed` (multi-desktop targeting)

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
