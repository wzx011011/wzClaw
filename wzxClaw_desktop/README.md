# wzxClaw

**[中文](#中文) | [English](#english)**

---

<a name="中文"></a>

## 中文

个人 AI 编程 IDE 桌面应用，类似 Cursor，基于 VS Code 同款技术栈打造。

### 简介

wzxClaw 将完整的 AI Agent Runtime 直接内嵌到桌面 GUI 中，配备 Monaco 编辑器和实时 Chat Panel，工具执行过程全程可见。支持多家 LLM 后端，通过统一网关路由。

**核心价值：** AI Agent 能正确调用工具（读写文件、执行命令、搜索代码）完成编程任务，用户能在 Chat Panel 中实时看到每一步的过程和结果。

**当前重点：** 高级能力验证、状态模型收敛、流式聊天与日常使用稳定性提升。

### 功能特性

- **多 LLM 支持** — OpenAI、Anthropic Claude、DeepSeek、GLM 及任何 OpenAI 兼容接口
- **Agent 循环** — 最多 25 轮多轮对话，达到 80% 上下文阈值时自动压缩
- **工具系统** — 25+ 个内置/本地工具：
  - `FileRead` / `FileWrite` / `FileEdit` — 工作区边界强制校验的文件操作
  - `Bash` — 带安全策略的 Shell 命令执行
  - `Grep` / `Glob` — 代码搜索
  - `BrowserNavigate` / `BrowserClick` / `BrowserType` / `BrowserScreenshot` / `BrowserEvaluate` / `BrowserClose` — 网页浏览与自动化
  - `WebSearch` / `WebFetch` — 网络信息检索
  - `SemanticSearch` — 本地语义搜索（Embedding API，失败时回退到 TF-IDF）
  - `GoToDefinition` / `FindReferences` / `SearchSymbols` — 代码符号导航
  - `CreateStep` / `UpdateStep` / `TodoWrite` — 步骤与待办追踪
  - `Agent` — 子 Agent 派生
  - `AskUser` — 任务中途向用户提问
  - `EnterPlanMode` / `ExitPlanMode` — 计划模式切换
- **流式输出** — Token 实时流式显示在 Chat Panel
- **权限系统** — 4 种模式：总是询问、接受编辑、计划模式、绕过
- **Monaco 编辑器** — VS Code 同款编辑器引擎，支持语法高亮和 100+ 种语言
- **手机端桥接** — 配套 Android App 通过 WebSocket 隧道远程控制

### 技术栈

| 层级               | 技术                                  |
| ------------------ | ------------------------------------- |
| 桌面壳             | Electron 41                           |
| 语言               | TypeScript 6                          |
| UI                 | React 19 + Zustand 5                  |
| 编辑器             | Monaco Editor 0.55                    |
| LLM（OpenAI 兼容） | openai SDK 6                          |
| LLM（Anthropic）   | @anthropic-ai/sdk 0.82                |
| 构建               | electron-vite 5 + electron-builder 26 |
| 测试               | Vitest                                |

### 安装

从 [Releases](../../releases) 下载最新安装包，运行即可。无需额外配置，启动后在应用内设置 API Key。

#### 从源码构建

```bash
# 前置条件：Node.js >= 20.19，npm >= 10
npm install
npm run dev          # 开发模式
npm run build:win    # 构建 Windows 安装包
```

### 配置

首次启动后，打开设置配置：

- **API Key** 和 **Base URL**（根据你使用的 LLM 服务商填写）
- **Model** — 例如 `claude-sonnet-4-6`、`deepseek-chat`、`gpt-4o`
- **权限模式** — 控制哪些工具调用需要用户确认

### 项目结构

```
src/
├── main/              # Electron 主进程
│   ├── agent/         # Agent 循环 + 上下文管理器
│   ├── llm/           # LLM 网关 + 适配器（OpenAI、Anthropic）
│   ├── tools/         # 工具实现
│   ├── permission/    # 权限管理器
│   ├── indexing/      # Embedding + TF-IDF fallback 语义搜索
│   └── mobile/        # Android 伴侣应用 WebSocket 隧道
├── renderer/          # React UI（Chat Panel、Monaco 编辑器）
└── shared/            # 类型定义和常量
```

---

<a name="english"></a>

## English

Personal AI coding IDE desktop application — a Cursor-like tool built on the VS Code tech stack.

### Overview

wzxClaw embeds a full AI Agent Runtime directly into a desktop GUI, with a Monaco Editor, real-time Chat Panel, and tool execution visible as it happens. It supports multiple LLM backends through a unified gateway.

**Core value:** The AI agent correctly calls tools (read/write files, run commands, search code) to complete programming tasks, and you see every step in the Chat Panel in real time.

**Current focus:** verification, runtime state-model cleanup, and stability work on the advanced feature set.

### Features

- **Multi-LLM support** — OpenAI, Anthropic Claude, DeepSeek, GLM, and any OpenAI-compatible endpoint
- **Agent loop** — multi-turn conversations with up to 25 turns, automatic context compaction at 80% threshold
- **Tool system** — 25+ built-in/local tools:
  - `FileRead` / `FileWrite` / `FileEdit` — workspace-boundary-enforced file operations
  - `Bash` — shell command execution with security policy
  - `Grep` / `Glob` — code search
  - `BrowserNavigate` / `BrowserClick` / `BrowserType` / `BrowserScreenshot` / `BrowserEvaluate` / `BrowserClose` — browser automation
  - `WebSearch` / `WebFetch` — internet research
  - `SemanticSearch` — local semantic search with embedding API and TF-IDF fallback
  - `GoToDefinition` / `FindReferences` / `SearchSymbols` — code symbol navigation
  - `CreateStep` / `UpdateStep` / `TodoWrite` — step and todo tracking
  - `Agent` — sub-agent spawning
  - `AskUser` — mid-task clarification
  - `EnterPlanMode` / `ExitPlanMode` — plan-mode control
- **Streaming** — real-time token streaming displayed in Chat Panel
- **Permission system** — 4 modes: always-ask, accept-edits, plan, bypass
- **Monaco Editor** — the actual VS Code editor engine with syntax highlighting and 100+ language support
- **Mobile bridge** — companion Android app connects via WebSocket tunnel for on-the-go control

### Tech Stack

| Layer               | Technology                            |
| ------------------- | ------------------------------------- |
| Desktop shell       | Electron 41                           |
| Language            | TypeScript 6                          |
| UI                  | React 19 + Zustand 5                  |
| Editor              | Monaco Editor 0.55                    |
| LLM (OpenAI-compat) | openai SDK 6                          |
| LLM (Anthropic)     | @anthropic-ai/sdk 0.82                |
| Build               | electron-vite 5 + electron-builder 26 |
| Tests               | Vitest                                |

### Installation

Download the latest installer from [Releases](../../releases) and run it. No additional setup needed — configure your API keys inside the application.

#### Build from source

```bash
# Prerequisites: Node.js >= 20.19, npm >= 10
npm install
npm run dev          # development mode
npm run build:win    # build Windows installer
```

### Configuration

On first launch, open Settings and configure:

- **API Key** and **Base URL** for your preferred LLM provider
- **Model** — e.g. `claude-sonnet-4-6`, `deepseek-chat`, `gpt-4o`
- **Permission mode** — controls which tool calls require approval

### Project structure

```
src/
├── main/              # Electron main process
│   ├── agent/         # Agent loop + context manager
│   ├── llm/           # LLM gateway + adapters (OpenAI, Anthropic)
│   ├── tools/         # Tool implementations
│   ├── permission/    # Permission manager
│   ├── indexing/      # Embedding + TF-IDF fallback semantic search
│   └── mobile/        # WebSocket tunnel for Android companion
├── renderer/          # React UI (Chat Panel, Monaco Editor)
└── shared/            # Types and constants
```

### License

Personal use. Not open-sourced.
