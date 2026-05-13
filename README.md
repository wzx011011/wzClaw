<h1 align="center">wzxClaw</h1>

<p align="center">
<strong>AI-Powered Coding IDE</strong> · 基于 AI Agent 的智能编程 IDE
</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/wzx011011/wzClaw?style=flat-square" alt="Stars" />
  <img src="https://img.shields.io/github/forks/wzx011011/wzClaw?style=flat-square" alt="Forks" />
  <img src="https://img.shields.io/github/issues/wzx011011/wzClaw?style=flat-square" alt="Issues" />
  <img src="https://img.shields.io/github/contributors/wzx011011/wzClaw?style=flat-square" alt="Contributors" />
  <img src="https://img.shields.io/github/last-commit/wzx011011/wzClaw?style=flat-square" alt="Last Commit" />
  <img src="https://img.shields.io/github/commit-activity/m/wzx011011/wzClaw?style=flat-square" alt="Commit Activity" />
  <img src="https://img.shields.io/github/repo-size/wzx011011/wzClaw?style=flat-square" alt="Repo Size" />
  <img src="https://img.shields.io/github/languages/count/wzx011011/wzClaw?style=flat-square" alt="Languages" />
  <img src="https://img.shields.io/github/languages/top/wzx011011/wzClaw?style=flat-square" alt="Top Language" />
  <br/>
  <img src="https://img.shields.io/github/v/release/wzx011011/wzClaw?style=flat-square" alt="Release" />
  <img src="https://img.shields.io/github/actions/workflow/status/wzx011011/wzClaw/ci.yml?branch=master&style=flat-square" alt="CI" />
  <img src="https://img.shields.io/github/license/wzx011011/wzClaw?style=flat-square" alt="License" />
  <br/>
  <img src="https://img.shields.io/badge/Electron-33-blue?style=flat-square" alt="Electron" />
  <img src="https://img.shields.io/badge/React-19-61dafb?style=flat-square" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Flutter-3.x-02569b?style=flat-square" alt="Flutter" />
  <img src="https://img.shields.io/badge/Monaco_Editor-0.55-blueviolet?style=flat-square" alt="Monaco Editor" />
  <img src="https://img.shields.io/badge/Zustand-5-orange?style=flat-square" alt="Zustand" />
</p>

---

**[English](#english) · [中文](#中文)**

---

<a id="english"></a>

## Overview

wzxClaw is a personal AI coding IDE inspired by [Cursor](https://cursor.sh). It features a built-in AI Agent runtime that can autonomously read/write files, execute shell commands, search code, and browse the web — all from a desktop chat interface. An Android companion app enables remote control via a WebSocket relay, so you can send coding instructions from your phone and watch the agent execute in real time.

**Key Highlights:**

- **Multi-LLM Backend** — Supports 13 models across 4 providers: GLM, OpenAI, DeepSeek, and Anthropic
- **17 Built-in Tools** — File read/write/edit, grep, glob, bash, web search, semantic search, symbol navigation, and more
- **AsyncGenerator Agent Loop** — Multi-turn conversation with auto-compaction at 80% context threshold (max 25 turns)
- **Permission System** — 4 modes: always-ask, accept-edits, plan, bypass — with session-scoped approval caching
- **MCP (Model Context Protocol)** — Extensible tool integration via stdio transport
- **Prompt Caching** — 3-level cache boundaries for Anthropic API (static prompt → tool defs → conversation history)
- **Mobile Companion** — Android app with streaming chat, voice input, file browsing, and push notifications
- **Observability** — Langfuse tracing for agent sessions (traces, generations, tool spans)
- **Plugin & Skill System** — Extensible via built-in and custom plugins/skills

## Demo Scenarios

### 1 · Ask the agent to refactor a function

> Type a natural-language request in the chat panel. The agent reads the file, plans the edit, asks for approval, and applies the change — all in one turn.

![Refactor demo](docs/demos/refactor.gif)

```
You  ▸  「把 parseConfig 函数改成支持 JSON 和 YAML 两种格式」

Agent ▸  [FileRead] src/config/parser.ts              ✓  (read-only, auto)
      ▸  [Grep] YAML in src/                          ✓  (read-only, auto)
      ▸  Thinking…
      ▸  [FileEdit] src/config/parser.ts              ⏸  waiting for approval

You  ▸  ✅ Accept

Agent ▸  Done — parseConfig now handles both .json and .yaml inputs.
```

---

### 2 · Mobile remote control: run a task from your phone

> Open the Android companion app, connect to your desktop via the relay, and send a coding task. The agent streams its progress back to your phone in real time.

![Mobile remote demo](docs/demos/mobile-remote.gif)

```
Android  ──WSS──▶  NAS Relay  ──WS──▶  wzxClaw Desktop

[Phone]  「写一个 REST API 测试脚本，覆盖 /users 的增删改查」

[Desktop Agent]
  ▸  [Bash] ls src/api/                               ✓
  ▸  [FileRead] src/api/users.ts                      ✓
  ▸  [FileWrite] test/api/users.test.ts               ✅ (accept-edits mode)
  ▸  [Bash] npm test -- test/api/users.test.ts        ✓  4 passed

[Phone]  ← 「✅ 测试脚本已生成，4 个用例全部通过。」  (streamed live)
```

---

### 3 · Context-aware multi-turn debugging

> Describe a bug. The agent locates the call site, reads surrounding code, proposes a fix, verifies with tests — and compacts the context automatically when it grows large.

![Debug demo](docs/demos/debug.gif)

```
You  ▸  「createSession 点击后侧边栏没有立刻出现新会话」

Agent ▸  [Grep] createSession in src/                 ✓
      ▸  [FileRead] src/renderer/stores/chat-store.ts ✓
      ▸  [FileRead] src/main/ipc-handlers/session-ipc-handlers.ts  ✓
      ▸  Root cause: meta line shape mismatch — listSessions()
         counts it as a real message instead of metadata.
      ▸  [FileEdit] session-ipc-handlers.ts           ⏸  approval

You  ▸  ✅ Accept

Agent ▸  [Bash] npx vitest run session-store.test.ts  ✓  13 passed
      ▸  Bug fixed — new sessions now appear immediately.

── auto-compact triggered at 78% context ──
```

> **To add your own recordings:** record with [LICEcap](https://www.cockos.com/licecap/) or [ScreenToGif](https://www.screentogif.com/), export as GIF, and drop the files into `docs/demos/`.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    wzxClaw Desktop                       │
│  ┌──────────┐  ←─IPC─→  ┌─────────┐  ←─bridge─→  ┌───┐ │
│  │  Main     │            │ Preload │              │ R │ │
│  │ (Node.js) │            │         │              │ e │ │
│  │           │            │         │              │ n │ │
│  │ Agent     │            │ context │              │ d │ │
│  │ Loop      │            │ Bridge  │              │ e │ │
│  │ + 17 Tools│            │         │              │ r │ │
│  │ + LLM GW  │            │         │              │ e │ │
│  └─────┬─────┘            └─────────┘              │ r │ │
│        │ WS                                         └───┘ │
│  ┌─────▼─────┐                                          │
│  │   Relay    │  ←── WSS (5945.top) ──→  Android App    │
│  │  (NAS)     │                                      │
│  └────────────┘                                       │
└─────────────────────────────────────────────────────────┘
```

The project follows Electron's three-process model:

| Process | Stack | Role |
|---------|-------|------|
| **Main** | Node.js + TypeScript | Agent loop, tool execution, LLM gateway, file watching, terminal management |
| **Preload** | contextBridge | Secure IPC bridge between main and renderer |
| **Renderer** | React 19 + Zustand 5 + Monaco Editor + xterm.js | IDE UI: editor, chat panel, file explorer, terminal, task management |

## Tech Stack

| Category | Technology | Version |
|----------|-----------|---------|
| **Desktop Shell** | Electron | 33.x |
| **UI Framework** | React | 19.x |
| **State Management** | Zustand | 5.x |
| **Code Editor** | Monaco Editor | 0.55.x |
| **Terminal** | node-pty + xterm.js | 1.1 / 5.3 |
| **Language** | TypeScript | 5.7.x |
| **Build** | electron-vite + electron-builder | 3.x / 25.x |
| **Testing** | Vitest | 3.x |
| **LLM SDK** | openai + @anthropic-ai/sdk | 6.x / 0.82.x |
| **Mobile** | Flutter + Dart | 3.x |
| **Relay** | Node.js + ws | 20.x / 8.18.x |
| **Observability** | Langfuse | 5.x |

## Supported Models

| Model | Provider | Context Window | Max Output |
|-------|----------|----------------|------------|
| GLM-5.1 / GLM-5 Turbo / GLM-5 | Zhipu (Anthropic API) | 128K | 16K |
| GLM-4 Plus / GLM-4 Flash | Zhipu (OpenAI API) | 128K | 8K |
| GPT-4o / GPT-4o Mini | OpenAI | 128K | 16K |
| DeepSeek-V4 Pro / Flash, V3, R1 | DeepSeek | 64K | 8K |
| Claude Sonnet 4 / Claude 3.5 Haiku | Anthropic | 200K | 8K |

## Quick Start

### Prerequisites

- **Node.js** >= 20.19.0
- **npm** >= 10.0.0
- **Flutter SDK** (stable channel, for Android app)
- **JDK 17** (for Android build)

### Desktop

```bash
cd wzxClaw_desktop
npm ci
npm test              # Run tests
npm run dev           # Start dev server (run outside VS Code/Cursor terminal)
npm run build:win     # Build Windows installer
```

> **Note:** `npm run dev` cannot run inside VS Code/Cursor's built-in terminal — it inherits `ELECTRON_RUN_AS_NODE=1` which breaks the Electron subprocess.

### Android

```bash
cd wzxClaw_android
flutter pub get
flutter analyze --no-fatal-infos
flutter test
# Build release APK (Windows)
build_apk.bat
# Or on Unix shell:
export JAVA_HOME="/path/to/jdk17"
flutter build apk --release
```

### Relay Server

```bash
cd relay
npm test
docker-compose up -d --build
docker logs wzxclaw-relay
```

## Project Structure

```
.
├── wzxClaw_desktop/          # Electron desktop IDE (247 files, ~51K LOC)
│   ├── src/
│   │   ├── main/             # Main process: agent loop, tools, LLM gateway, etc.
│   │   │   ├── agent/        # Agent loop, turn manager, stream phase
│   │   │   ├── llm/          # Gateway + OpenAI/Anthropic adapters
│   │   │   ├── tools/        # 17 tool implementations + registry
│   │   │   ├── context/      # Token counting, auto-compaction
│   │   │   ├── terminal/     # PTY terminal management
│   │   │   ├── mcp/          # Model Context Protocol client
│   │   │   ├── mobile/       # Relay client for Android companion
│   │   │   ├── permission/   # Permission/approval system
│   │   │   ├── plugins/      # Plugin system
│   │   │   ├── skills/       # Skill system
│   │   │   ├── memory/       # Persistent memory manager
│   │   │   ├── indexing/     # Semantic search (code embeddings)
│   │   │   ├── browser/      # Browser automation
│   │   │   ├── hooks/        # Hook system
│   │   │   ├── insights/     # Session analysis
│   │   │   └── observability/ # Langfuse tracing
│   │   ├── renderer/         # React UI
│   │   │   ├── components/   # Chat, IDE, tasks, UI components
│   │   │   └── stores/       # 13 Zustand stores
│   │   └── shared/           # Cross-process types, IPC channels, constants
│   └── scripts/              # Build scripts, eval benchmarks
│
├── wzxClaw_android/          # Flutter Android app (37 files, ~12K LOC)
│   ├── lib/
│   │   ├── services/         # Singleton services with StreamController
│   │   ├── models/           # Immutable data classes
│   │   ├── pages/            # Home, settings, file browser/viewer
│   │   ├── widgets/          # 15+ StreamBuilder-based widgets
│   │   └── config/           # App constants and theme
│   └── android/              # Android native project
│
├── relay/                    # WebSocket relay server (NAS deployment)
│   ├── server.js             # HTTP + WebSocket server
│   ├── lib/
│   │   ├── room.js           # Token-keyed rooms, offline queues
│   │   ├── auth.js           # Timing-safe token auth
│   │   ├── logger.js         # Logging
│   │   └── push-provider.js  # Firebase push notifications
│   ├── nginx/                # Reverse proxy configs
│   ├── test/                 # Unit + e2e tests
│   ├── Dockerfile            # Multi-stage build (node:20-alpine)
│   └── docker-compose.yml    # NAS deployment config
│
└── .github/workflows/        # CI/CD: ci.yml + release.yml
```

## Built-in Tools

| Tool | Category | Description |
|------|----------|-------------|
| FileRead | Read-only | Read file contents |
| Grep | Read-only | Regex search across files |
| Glob | Read-only | File pattern matching |
| LS | Read-only | List directory contents |
| WebSearch | Read-only | Web search via SearXNG |
| WebFetch | Read-only | Fetch and read web pages |
| SemanticSearch | Read-only | Vector-based code search |
| GoToDefinition | Navigation | Jump to symbol definition |
| FindReferences | Navigation | Find all symbol references |
| SearchSymbols | Navigation | Search symbols in workspace |
| CreateStep | Task | Create task step |
| UpdateStep | Task | Update task step status |
| TodoWrite | Task | Manage todo list |
| FileWrite | Destructive | Create or overwrite files |
| FileEdit | Destructive | String replacement in files |
| MultiEdit | Destructive | Multi-location edits |
| Bash | Destructive | Execute shell commands |

Read-only tools execute automatically during streaming. Destructive tools require user approval based on the active permission mode.

## CI/CD

Two GitHub Actions workflows are configured:

- **`ci.yml`** — On push/PR to `master`: runs desktop tests, build check, Flutter analyze/test, and Android APK build
- **`release.yml`** — On tag `v*`: builds Windows installer + Android APK, publishes GitHub release

## License

This project is licensed under the **MIT License**.

---

<a id="中文"></a>

## 项目简介

wzxClaw 是一款受 [Cursor](https://cursor.sh) 启发的个人 AI 编程 IDE。内置 AI Agent 运行时，可自主读写文件、执行 Shell 命令、搜索代码和浏览网页——全部通过桌面端聊天界面完成。Android 伴侣应用通过 WebSocket 中继实现远程控制，用户可在手机上发送编程指令，实时观看 Agent 执行过程。

**核心特性：**

- **多 LLM 后端** — 支持 4 家供应商共 13 个模型：智谱 GLM、OpenAI、DeepSeek、Anthropic
- **17 个内置工具** — 文件读写/编辑、grep、glob、bash、网页搜索、语义搜索、符号导航等
- **AsyncGenerator Agent Loop** — 多轮对话，80% 上下文阈值自动压缩（最大 25 轮）
- **权限系统** — 4 种模式：始终询问、接受编辑、计划模式、绕过——支持会话级审批缓存
- **MCP 协议** — 通过 stdio 传输的 Model Context Protocol，可扩展工具集成
- **提示缓存** — Anthropic API 三级缓存边界（静态提示 → 工具定义 → 对话历史）
- **移动伴侣** — Android 应用支持流式对话、语音输入、文件浏览和推送通知
- **可观测性** — Langfuse 链路追踪（traces、generations、tool spans）
- **插件与技能系统** — 通过内置和自定义插件/技能扩展功能

## 演示场景

### 1 · 让 Agent 重构一个函数

> 在聊天面板输入自然语言需求。Agent 读取文件、规划编辑、等待审批、一次性应用改动。

![重构演示](docs/demos/refactor.gif)

```
用户  ▸  「把 parseConfig 函数改成支持 JSON 和 YAML 两种格式」

Agent ▸  [FileRead] src/config/parser.ts              ✓  （只读，自动执行）
      ▸  [Grep] YAML in src/                          ✓  （只读，自动执行）
      ▸  思考中…
      ▸  [FileEdit] src/config/parser.ts              ⏸  等待审批

用户  ▸  ✅ 允许

Agent ▸  完成——parseConfig 现已支持 .json 和 .yaml 两种输入格式。
```

---

### 2 · 手机远程控制：在手机上发起编程任务

> 打开 Android 伴侣应用，通过中继服务连接桌面端，发送编程任务。Agent 将执行进度实时流式推送回手机。

![手机远控演示](docs/demos/mobile-remote.gif)

```
Android ──WSS──▶ NAS 中继 ──WS──▶ wzxClaw 桌面端

[手机]  「写一个 REST API 测试脚本，覆盖 /users 的增删改查」

[桌面 Agent]
  ▸  [Bash] ls src/api/                               ✓
  ▸  [FileRead] src/api/users.ts                      ✓
  ▸  [FileWrite] test/api/users.test.ts               ✅ （接受编辑模式，自动）
  ▸  [Bash] npm test -- test/api/users.test.ts        ✓  4 个用例通过

[手机]  ← 「✅ 测试脚本已生成，4 个用例全部通过。」  （实时流式）
```

---

### 3 · 上下文感知的多轮调试

> 描述一个 Bug。Agent 定位调用链、读取相关代码、提出修复方案、用测试验证——上下文过大时自动压缩。

![调试演示](docs/demos/debug.gif)

```
用户  ▸  「createSession 点击后侧边栏没有立刻出现新会话」

Agent ▸  [Grep] createSession in src/                 ✓
      ▸  [FileRead] src/renderer/stores/chat-store.ts ✓
      ▸  [FileRead] src/main/ipc-handlers/session-ipc-handlers.ts  ✓
      ▸  根因：meta 行格式不一致——listSessions() 将其计入真实消息而非元数据。
      ▸  [FileEdit] session-ipc-handlers.ts           ⏸  等待审批

用户  ▸  ✅ 允许

Agent ▸  [Bash] npx vitest run session-store.test.ts  ✓  13 个用例通过
      ▸  Bug 已修复——新会话现在可以立即显示在侧边栏。

── 上下文使用率达 78%，已自动触发压缩 ──
```

> **添加自己的录屏：** 使用 [LICEcap](https://www.cockos.com/licecap/) 或 [ScreenToGif](https://www.screentogif.com/) 录制，导出为 GIF，放入 `docs/demos/` 目录即可。

## 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                    wzxClaw 桌面端                        │
│  ┌──────────┐  ←─IPC─→  ┌─────────┐  ←─bridge─→  ┌───┐ │
│  │  主进程    │            │ 预加载  │              │ 渲 │ │
│  │ (Node.js) │            │  脚本   │              │ 染 │ │
│  │           │            │         │              │ 进 │ │
│  │  Agent    │            │ 上下文  │              │ 程 │ │
│  │  循环     │            │  桥接   │              │   │ │
│  │ +17个工具 │            │         │              │ R │ │
│  │ +LLM网关  │            │         │              │ e │ │
│  └─────┬─────┘            └─────────┘              │ a │ │
│        │ WS                                         │ c │ │
│  ┌─────▼─────┐                                       │ t │ │
│  │  中继服务  │  ←── WSS (5945.top) ──→  Android 应用 │   │ │
│  │  (NAS)    │                                       └───┘ │
│  └────────────┘                                            │
└─────────────────────────────────────────────────────────┘
```

项目遵循 Electron 三进程模型：

| 进程 | 技术栈 | 职责 |
|------|--------|------|
| **主进程** | Node.js + TypeScript | Agent 循环、工具执行、LLM 网关、文件监控、终端管理 |
| **预加载脚本** | contextBridge | 主进程与渲染进程间的安全 IPC 桥接 |
| **渲染进程** | React 19 + Zustand 5 + Monaco Editor + xterm.js | IDE 界面：编辑器、聊天面板、文件浏览器、终端、任务管理 |

## 技术栈

| 分类 | 技术 | 版本 |
|------|------|------|
| **桌面框架** | Electron | 33.x |
| **UI 框架** | React | 19.x |
| **状态管理** | Zustand | 5.x |
| **代码编辑器** | Monaco Editor | 0.55.x |
| **终端** | node-pty + xterm.js | 1.1 / 5.3 |
| **开发语言** | TypeScript | 5.7.x |
| **构建工具** | electron-vite + electron-builder | 3.x / 25.x |
| **测试框架** | Vitest | 3.x |
| **LLM SDK** | openai + @anthropic-ai/sdk | 6.x / 0.82.x |
| **移动端** | Flutter + Dart | 3.x |
| **中继服务** | Node.js + ws | 20.x / 8.18.x |
| **可观测性** | Langfuse | 5.x |

## 支持的模型

| 模型 | 供应商 | 上下文窗口 | 最大输出 |
|------|--------|------------|----------|
| GLM-5.1 / GLM-5 Turbo / GLM-5 | 智谱（Anthropic API） | 128K | 16K |
| GLM-4 Plus / GLM-4 Flash | 智谱（OpenAI API） | 128K | 8K |
| GPT-4o / GPT-4o Mini | OpenAI | 128K | 16K |
| DeepSeek-V4 Pro / Flash, V3, R1 | DeepSeek | 64K | 8K |
| Claude Sonnet 4 / Claude 3.5 Haiku | Anthropic | 200K | 8K |

## 快速开始

### 环境要求

- **Node.js** >= 20.19.0
- **npm** >= 10.0.0
- **Flutter SDK**（stable 通道，用于 Android 应用）
- **JDK 17**（用于 Android 构建）

### 桌面端

```bash
cd wzxClaw_desktop
npm ci
npm test              # 运行测试
npm run dev           # 启动开发服务器（需在 VS Code/Cursor 外部终端运行）
npm run build:win     # 构建 Windows 安装包
```

> **注意：** `npm run dev` 不能在 VS Code/Cursor 内置终端中运行——它会继承 `ELECTRON_RUN_AS_NODE=1` 环境变量，导致 Electron 子进程异常。

### Android 端

```bash
cd wzxClaw_android
flutter pub get
flutter analyze --no-fatal-infos
flutter test
# 构建正式版 APK（Windows）
build_apk.bat
# 或在 Unix shell 中：
export JAVA_HOME="/path/to/jdk17"
flutter build apk --release
```

### 中继服务

```bash
cd relay
npm test
docker-compose up -d --build
docker logs wzxclaw-relay
```

## 项目结构

```
.
├── wzxClaw_desktop/          # Electron 桌面 IDE（247 个文件，约 51K 行代码）
│   ├── src/
│   │   ├── main/             # 主进程：Agent 循环、工具、LLM 网关等
│   │   │   ├── agent/        # Agent 循环、Turn 管理器、流处理
│   │   │   ├── llm/          # 网关 + OpenAI/Anthropic 适配器
│   │   │   ├── tools/        # 17 个工具实现 + 注册表
│   │   │   ├── context/      # Token 计数、自动压缩
│   │   │   ├── terminal/     # PTY 终端管理
│   │   │   ├── mcp/          # Model Context Protocol 客户端
│   │   │   ├── mobile/       # Android 伴侣的中继客户端
│   │   │   ├── permission/   # 权限/审批系统
│   │   │   ├── plugins/      # 插件系统
│   │   │   ├── skills/       # 技能系统
│   │   │   ├── memory/       # 持久化记忆管理
│   │   │   ├── indexing/     # 语义搜索（代码嵌入）
│   │   │   ├── browser/      # 浏览器自动化
│   │   │   ├── hooks/        # Hook 系统
│   │   │   ├── insights/     # 会话分析
│   │   │   └── observability/ # Langfuse 链路追踪
│   │   ├── renderer/         # React UI
│   │   │   ├── components/   # 聊天、IDE、任务、UI 组件
│   │   │   └── stores/       # 13 个 Zustand store
│   │   └── shared/           # 跨进程类型、IPC 通道、常量
│   └── scripts/              # 构建脚本、评估基准
│
├── wzxClaw_android/          # Flutter Android 应用（37 个文件，约 12K 行代码）
│   ├── lib/
│   │   ├── services/         # 单例服务（StreamController 广播）
│   │   ├── models/           # 不可变数据类
│   │   ├── pages/            # 主页、设置、文件浏览/查看
│   │   ├── widgets/          # 15+ StreamBuilder 响应式组件
│   │   └── config/           # 应用常量和主题
│   └── android/              # Android 原生工程
│
├── relay/                    # WebSocket 中继服务（NAS 部署）
│   ├── server.js             # HTTP + WebSocket 服务器
│   ├── lib/
│   │   ├── room.js           # Token 分组房间、离线队列
│   │   ├── auth.js           # 时序安全 Token 认证
│   │   ├── logger.js         # 日志
│   │   └── push-provider.js  # Firebase 推送通知
│   ├── nginx/                # 反向代理配置
│   ├── test/                 # 单元 + 端到端测试
│   ├── Dockerfile            # 多阶段构建（node:20-alpine）
│   └── docker-compose.yml    # NAS 部署配置
│
└── .github/workflows/        # CI/CD：ci.yml + release.yml
```

## 内置工具

| 工具 | 分类 | 说明 |
|------|------|------|
| FileRead | 只读 | 读取文件内容 |
| Grep | 只读 | 跨文件正则搜索 |
| Glob | 只读 | 文件模式匹配 |
| LS | 只读 | 列出目录内容 |
| WebSearch | 只读 | 通过 SearXNG 网页搜索 |
| WebFetch | 只读 | 获取并读取网页 |
| SemanticSearch | 只读 | 基于向量的代码搜索 |
| GoToDefinition | 导航 | 跳转到符号定义 |
| FindReferences | 导航 | 查找所有符号引用 |
| SearchSymbols | 导航 | 在工作区搜索符号 |
| CreateStep | 任务 | 创建任务步骤 |
| UpdateStep | 任务 | 更新任务步骤状态 |
| TodoWrite | 任务 | 管理待办列表 |
| FileWrite | 破坏性 | 创建或覆盖文件 |
| FileEdit | 破坏性 | 文件内字符串替换 |
| MultiEdit | 破坏性 | 多位置编辑 |
| Bash | 破坏性 | 执行 Shell 命令 |

只读工具在流式传输期间自动执行。破坏性工具根据当前权限模式需用户审批。

## CI/CD

配置了两个 GitHub Actions 工作流：

- **`ci.yml`** — 推送/PR 到 `master` 时触发：运行桌面端测试、构建检查、Flutter 分析/测试、Android APK 构建
- **`release.yml`** — 打 `v*` 标签时触发：构建 Windows 安装包 + Android APK，发布 GitHub Release

## 许可证

本项目基于 **MIT 许可证** 授权。
