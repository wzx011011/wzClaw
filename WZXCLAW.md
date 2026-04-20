## Project

AI 编程 IDE 桌面应用（类 Cursor），基于 Electron + Monaco Editor + React + TypeScript，内建多轮 Agent Runtime，支持 OpenAI/Anthropic/DeepSeek/GLM 等多 LLM 后端，含手机端 WebSocket 远程控制。

## Build & Dev Commands

- `npm run dev` — 启动开发模式（通过 scripts/dev.js 清除 ELECTRON_RUN_AS_NODE 后调用 electron-vite dev）
- `npm run build:win` — 构建 Windows 安装包（nsis）
- `npm test` / `npm run test:watch` — vitest 单元测试（环境为 node，glob 为 `src/**/*.test.ts`）
- `npm run eval:run` — 运行 eval 基准测试套件

## Architecture Overview

Electron 三进程架构：main（Node.js 后端）、preload（contextBridge IPC 桥接）、renderer（React UI）。主进程中 `AgentLoop` 驱动多轮 LLM 对话，通过 `LLMGateway` 路由到 OpenAI 或 Anthropic 适配器，工具调用由 `ToolRegistry` 分发。通信全部通过 `IPC_CHANNELS` 常量定义的命名通道（ipcMain.handle / webContents.send），payload 类型在 `shared/ipc-channels.ts` 中集中维护。手机端通过 `RelayClient`（WebSocket）或直连 `MobileServer` 与主进程通信。会话持久化为 JSONL 文件（`SessionStore`）。

## Key Conventions

- **IPC 通道集中定义**：所有通道名、请求/响应/流 payload 类型在 `shared/ipc-channels.ts`，新增通道必须在此注册
- **`@shared` 别名**：三个进程（main/preload/renderer）统一用 `@shared` 引用 `src/shared`，renderer 额外有 `@renderer` 别名
- **Agent 事件流**：`AgentLoop.run()` 返回 `AsyncGenerator<AgentEvent>`，事件逐条穿透到 renderer，不要改为回调或 Promise 模式
- **中文注释**：代码注释使用中文
- **GLM-5 系列走 Anthropic 适配器**：`gateway.ts` 中 `detectProvider` 将 `glm-5*` 路由到 anthropic adapter（兼容 API）
- **工具类命名**：`XxxTool` 类实现 `Tool` 接口（`tool-interface.ts`），注册到 `ToolRegistry`
- **Renderer 状态**：Zustand store（`chat-store.ts` 为核心），不使用 React Context

## Development Notes

- **Node.js >= 20.19**：electron-vite 5.x 的硬性要求
- **`npm run dev` 不能在 VS Code/Cursor 内置终端直接运行**：会继承 `ELECTRON_RUN_AS_NODE=1` 导致子进程异常，scripts/dev.js 会自动清除
- **测试不需要启动 Electron**：vitest 配置为 node 环境，测试 pure TypeScript 逻辑（agent loop 用 mock generator），不涉及 E2E
- **主进程入口是 `src/main/index.ts`**，超过 1000 行，是 IPC handler、mobile 消息分发、session 管理的枢纽
- **会话存储**：每个会话一个 `.jsonl` 文件，由 `SessionStore` 管理，路径为 `{workspace}/.wzxclaw/sessions/`
- **eval 系统**：`eval/` 目录和 `scripts/eval/` 下是一套完整的 prompt 优化和基准测试框架，独立于主应用逻辑
- **手机端消息处理**：`index.ts` 中的 `handleClientMessage` 按 `msg.event` 分发，注意手机端操作（删除/重命名会话）后需同时通知 renderer，否则桌面端状态不同步
