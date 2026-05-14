---
name: "Brain-Hands-Session 全架构迁移"
phase: 1
wave: 1
depends_on: []
requirements: []
autonomous: false
---

# Brain-Hands-Session 全架构迁移

## 目标

将 wzxClaw 从当前的 Pet 模式迁移为 Anthropic Cattle 模式，同时统一桌面端和手机端技术栈：

- **NAS 运行 Brain**（AgentLoop + LLM Gateway + Context + Session）
- **桌面端 = Electron 壳**（Hand Bridge + Monaco/xterm 等 IDE 增强）
- **手机端 = Capacitor 壳**（套同一个 React Web UI，接近原生体验）
- **共享 React Web UI** — 桌面和手机 80%+ 代码共享
- **Hand 是独立服务** — `npx wzxclaw-hand` 任何机器一行注册
- **一个 Brain 连多个 Hand**（桌面/Docker/任意机器）

## 当前架构 → 目标架构

```
当前 (Pet 模式，两套代码库):

  Flutter 手机 ──WSS──→ NAS Relay ──WSS──→ Electron 桌面
  (Dart)                                   (TypeScript/React)
       ├── 完全不同的代码                    ├── Brain (AgentLoop)
       ├── 完全不同的 UI                     ├── Hands (25+ Tools)
       └── 独立的状态管理                    └── Session (JSONL)


目标 (Cattle 模式，一套 UI):

  ┌──────────────────────────────────────────────────────────┐
  │              packages/web-ui/ (React SPA)                │
  │   聊天 UI · Session 管理 · 设置 · Hand 状态 · 流式显示   │
  └────────────┬────────────────────────────┬────────────────┘
               │ 套壳                        │ 套壳
  ┌────────────▼──────────┐    ┌────────────▼──────────┐
  │  桌面端 (Electron 壳)  │    │  手机端 (Capacitor 壳) │
  │                       │    │                       │
  │  + Hand Bridge        │    │  + 原生状态栏          │
  │  + Monaco 编辑器      │    │  + 启动画面            │
  │  + xterm 终端         │    │  + 手势导航            │
  │  + 文件系统           │    │  + 推送通知            │
  │  + 系统托盘           │    │  + 后台保活            │
  └───────────┬───────────┘    └───────────┬───────────┘
              │ WSS                        │ WSS
              └────────→ NAS Brain ←───────┘
                           │
                 ┌─────────┼─────────┐
                 │         │         │
            桌面 Hand   Docker Hand  LLM APIs
           (Windows)   (NAS 沙箱)
```

## 技术栈对比

| | 现状 | 迁移后 |
|---|---|---|
| 桌面端 | Electron + React | **Electron + React（不变）** |
| 手机端 | Flutter (Dart) | **Capacitor + React（同一套 UI）** |
| 共享代码 | 0% | **80%+** |
| Brain | 桌面 Electron 进程内 | **NAS Docker 独立服务** |
| Hand | 桌面 ToolRegistry | **独立 npm 包，可插拔** |
| Session | 桌面 JSONL | **NAS SQLite，多客户端共享** |
| 手机→桌面 | Relay 中转 | **手机直连 NAS Brain** |

---

## Monorepo 结构

```
wzxClaw/
├── packages/
│   ├── brain/              # Brain 核心 — AgentLoop + LLM Gateway + Context
│   │   └── src/
│   │       ├── agent-loop.ts
│   │       ├── turn-manager.ts
│   │       ├── stream-phase.ts
│   │       ├── system-prompt-builder.ts
│   │       ├── llm/             # gateway, adapters, retry
│   │       ├── context/         # context-manager, microcompact
│   │       └── interfaces.ts    # IToolExecutor, IStreamProvider, ISessionStore
│   │
│   ├── agent-server/        # NAS Agent 服务 — WebSocket + HTTP
│   │   └── src/
│   │       ├── server.ts        # WebSocket + HTTP 入口
│   │       ├── client-handler.ts  # 客户端连接管理
│   │       ├── hands-router.ts    # Hand 注册 + 路由
│   │       ├── session-sqlite.ts  # SQLite Session 实现
│   │       ├── auth.ts           # Token 认证
│   │       └── Dockerfile
│   │
│   ├── hand/                # Hand 独立包 — 任何机器可用
│   │   └── src/
│   │       ├── hand-client.ts   # WebSocket 客户端
│   │       ├── tool-runner.ts   # 工具执行管线
│   │       ├── tools/           # FileRead/Write, Bash, Grep, Glob...
│   │       └── bin/cli.ts       # npx wzxclaw-hand
│   │
│   └── web-ui/              # 共享 React UI — 桌面和手机共用
│       └── src/
│           ├── components/      # 聊天气泡、消息流、工具调用卡片
│           ├── stores/          # Zustand: chat-store, session-store
│           ├── services/        # WebSocket 连接、Session 管理
│           ├── hooks/           # useChat, useSession, useStream
│           └── styles/          # 共享样式
│
├── desktop/                 # Electron 壳
│   └── src/main/
│       ├── hand-bridge.ts       # Hand 服务（桥接本地工具到 Brain）
│       ├── electron-addons.ts   # Monaco, xterm, 文件系统
│       └── index.ts
│
├── mobile/                  # Capacitor 壳 (替代 wzxClaw_android)
│   ├── android/
│   ├── ios/
│   ├── capacitor.config.ts
│   └── src/native-bridges.ts    # 原生能力桥接
│
├── relay/                   # 保留，可能合并到 agent-server
└── CLAUDE.md
```

---

## 迁移路径（7 个阶段）

### 阶段 1: 提取 Brain 核心 — 脱离 Electron

**目标**: AgentLoop + LLM Gateway + Context 成为独立 Node.js 包

**产出**: `packages/brain/`

**步骤**:
1. 初始化 `packages/brain/`（tsconfig、package.json、vitest）
2. 从 `wzxClaw_desktop/src/main/` 复制:
   - `agent/` → agent-loop, turn-manager, stream-phase, system-prompt-builder
   - `llm/` → gateway, adapters, retry, types
   - `context/` → context-manager, microcompact, token-counter
3. 移除所有 Electron 依赖:
   - `ipc-main` / `BrowserWindow` / `safeStorage` / `dialog` → 删除或替换为接口
4. 定义核心接口 `packages/brain/src/interfaces.ts`:
   ```typescript
   interface IToolExecutor {
     execute(name: string, input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult>
     getDefinitions(): ToolDefinition[]
     isReadOnly(toolName: string): boolean
   }
   interface IStreamProvider {
     stream(options: StreamOptions): AsyncGenerator<StreamEvent>
   }
   interface ISessionStore {
     appendMessage(sessionId: string, message: ConversationMessage): Promise<void>
     loadSession(sessionId: string): Promise<ConversationMessage[]>
     listSessions(): Promise<SessionMeta[]>
     deleteSession(sessionId: string): Promise<void>
     getSessionTail(sessionId: string, count: number): Promise<ConversationMessage[]>
   }
   ```
5. AgentLoop 构造函数改为依赖接口
6. TurnManager 移除 `createExecuteToolFn()`，改为接收 `IToolExecutor`
7. 编写单元测试（mock 接口）
8. 桌面端通过适配器桥接，功能不变

**验证**:
- `packages/brain/` 的 `npm test` 通过
- 无 Electron 依赖
- 桌面端通过适配器使用，功能正常

---

### 阶段 2: Agent 服务器 — NAS 部署

**目标**: Brain 包作为 WebSocket 服务器部署到 NAS Docker

**产出**: `packages/agent-server/`

**步骤**:
1. 创建 `packages/agent-server/`，依赖 `packages/brain`
2. WebSocket 服务器: 两种连接类型
   - `client`（桌面/手机 UI）: 发消息 → AgentLoop → 流式返回
   - `hand`（工具执行者）: 注册能力 → 接收调用 → 返回结果
3. `SessionStoreSqlite implements ISessionStore`（WAL 模式，NAS 持久卷）
4. `HandsRouter`: Hand 注册、路由、健康检查、fallback
5. `HandAwareToolExecutor implements IToolExecutor`: 聚合在线 Hand 的工具定义 + 路由执行
6. Token 认证（复用 relay auth）
7. Docker 部署 + nginx: `wss://5945.top/agent/`

**客户端协议 (Client ↔ Brain)**:
```
→ chat:send          { sessionId, message }
← stream:text        { delta }
← stream:tool_call   { name, input }
← stream:tool_result { output }
← stream:done        { usage }
← session:list       [...]
```

**Hand 协议 (Hand ↔ Brain)**:
```
→ hand:register      { id, capabilities, definitions }
← hand:execute       { callId, name, input }
→ hand:result        { callId, output, isError }
← hand:heartbeat     { status }
```

**验证**: Docker 启动 → 桌面 WebSocket 连接 → 发消息 → 收流式回复 → Hand 注册 → 工具调用路由

---

### 阶段 3: Hand 服务 — 独立 npm 包

**目标**: `wzxclaw-hand` 任何机器一行命令注册为 Hand

**产出**: `packages/hand/`

**步骤**:
1. 从桌面端 `src/main/tools/` 提取工具: FileRead/Write/Edit, Bash, Grep, Glob...
2. `HandClient` 类:
   ```typescript
   const hand = new HandClient({
     brainUrl: 'wss://5945.top/agent',
     token: 'xxx',
     workingDir: '/path/to/project'
   })
   hand.start()  // 连接 Brain，注册 Hand
   ```
3. CLI: `npx wzxclaw-hand --brain wss://... --token xxx --dir /project`
4. 工具执行管线: 收 `hand:execute` → 本地执行 → 返回 `hand:result`
5. 权限本地管理 + 心跳保活

**验证**: 任意机器 `npx wzxclaw-hand` → Brain 注册 → 工具调用路由成功

---

### 阶段 4: 共享 Web UI — React SPA

**目标**: 从桌面端 Renderer 中提取共享 UI 层

**产出**: `packages/web-ui/`

**步骤**:
1. 从 `wzxClaw_desktop/src/renderer/` 提取核心 UI:
   - 聊天组件: 消息流、流式显示、工具调用卡片、thinking 折叠
   - Session 管理: 列表、创建、删除、切换
   - 设置页面: 模型配置、API Key
   - 状态管理: Zustand stores（chat-store, session-store）
2. 抽象数据源:
   ```typescript
   // 当前: 直接 IPC 调用 window.wzxclaw.*
   // 改为: 通过 interface 注入
   interface IBackendClient {
     sendMessage(sessionId: string, message: string): void
     onStreamEvent(callback: (event: StreamEvent) => void): void
     listSessions(): Promise<SessionMeta[]>
     // ...
   }
   ```
3. 两个实现:
   - `ElectronBackend` — 通过 IPC 调用本地 Electron（桌面端用）
   - `WebSocketBackend` — 通过 WebSocket 连接 NAS Brain（手机端/桌面远程模式用）
4. 响应式设计: 适配桌面宽屏和手机竖屏
5. 构建为独立 SPA，可被 Electron 和 Capacitor 引用

**验证**:
- `packages/web-ui/` 可独立 dev server 运行
- 通过 WebSocketBackend 连接 NAS Brain，聊天功能正常
- 响应式布局在桌面和手机尺寸都正常

---

### 阶段 5: 桌面端改造 — Electron 壳 + Hand Bridge

**目标**: 桌面 Electron 套 web-ui + Hand Bridge

**产出**: `desktop/` 重构

**步骤**:
1. Electron 主进程:
   - `hand-bridge.ts`: 注册为 Hand，桥接本地工具到 Brain
   - `electron-addons.ts`: Monaco 编辑器、xterm 终端、文件系统（web-ui 之外的桌面增强）
   - 启动时双连接: brain-client (客户端) + hand-bridge (Hand)
2. Renderer 加载 `packages/web-ui/`:
   - web-ui 通过 `ElectronBackend` 注入数据源
   - 桌面增强功能（Monaco/xterm）通过 Electron preload 桥接
3. 离线模式: NAS 不可达时回退本地 Brain
4. 新增 UI: NAS 连接状态、Hand 状态面板

**验证**:
- 桌面连接 NAS Brain，聊天 + 工具执行正常
- Monaco/xterm 等桌面增强功能正常
- NAS 离线时自动回退本地模式

---

### 阶段 6: 手机端重建 — Capacitor 壳

**目标**: 用 Capacitor 套 web-ui，替代 Flutter 项目

**产出**: `mobile/` 替代 `wzxClaw_android/`

**步骤**:
1. 初始化 Capacitor 项目:
   ```bash
   npm init -y
   npm install @capacitor/core @capacitor/cli
   npx cap init wzxClaw com.wzxclaw.app
   npx cap add android
   ```
2. 引用 `packages/web-ui/` 作为 Web 资源
3. 原生能力桥接:
   - `@capacitor/status-bar` — 状态栏控制
   - `@capacitor/splash-screen` — 启动画面
   - `@capacitor/push-notifications` — 推送通知（可选）
   - `@capacitor/app` — App 生命周期（前后台）
   - `@capacitor/haptics` — 触觉反馈
4. WebView 通过 `WebSocketBackend` 连接 NAS Brain
5. 移动端适配:
   - 手势导航（返回/滑动）
   - 下拉刷新 Session 列表
   - 长按消息弹出操作菜单
6. 构建打包:
   ```bash
   npx cap sync android
   cd android && ./gradlew assembleRelease
   # 产物: android/app/build/outputs/apk/release/app-release.apk
   ```

**Capacitor 壳提供的能力**:

| 能力 | 纯浏览器 | Capacitor |
|------|---------|-----------|
| App 图标/启动画面 | ❌ | ✅ |
| 全屏沉浸体验 | ❌ | ✅ |
| 手势返回 | 系统 WebView | ✅ 原生 |
| 状态栏控制 | ❌ | ✅ |
| 推送通知 | 浏览器支持 | ✅ 原生 |
| 后台保活 | ❌ | ✅ |
| 应用商店分发 | ❌ | ✅ Google Play |

**验证**:
- Capacitor Android 构建成功
- 手机安装 APK，体验接近原生 App
- 直连 NAS Brain，聊天/工具调用正常
- 桌面在线 → Hand 路由到桌面；桌面离线 → Hand 路由到 Docker

---

### 阶段 7: Docker Hand — NAS 本地沙箱

**目标**: NAS 上运行 Docker Hand，桌面离线时手机可独立使用

**产出**: `packages/hand-docker/`

**步骤**:
1. 基于 `packages/hand/` 构建 Docker 镜像（node:20-slim + git + python3）
2. 自动连接 NAS 本地 Brain: `ws://localhost:8082`
3. Brain 路由策略:
   - 桌面项目 + 桌面在线 → 桌面 Hand
   - 桌面离线 或 NAS 项目 → Docker Hand
4. `/workspace` 映射 NAS 持久存储

**验证**: 关闭桌面 → 手机发消息 → Brain 路由到 Docker Hand → 执行成功

---

## 整体依赖链

```
阶段 1: 提取 Brain (脱离 Electron)
  │
  ▼
阶段 2: Agent Server (NAS 部署)
  │
  ├──────────────────────┐
  ▼                      ▼
阶段 3: Hand 服务    阶段 4: 共享 Web UI
  │                      │
  │              ┌───────┴────────┐
  │              ▼                ▼
  │        阶段 5: 桌面端     阶段 6: 手机端
  │        (Electron 壳)    (Capacitor 壳)
  │              │                │
  └──────┬───────┘                │
         ▼                        │
    阶段 7: Docker Hand ←─────────┘
```

## 关键决策

1. **统一技术栈**: React + TypeScript 全栈，废弃 Flutter
2. **Capacitor 套壳**: 手机端接近原生体验，代码与桌面共享
3. **web-ui 独立**: `packages/web-ui/` 可独立运行，可被 Electron/Capacitor/浏览器引用
4. **数据源抽象**: `IBackendClient` 接口，Electron 和 WebSocket 两种实现
5. **monorepo 结构**: brain / agent-server / hand / web-ui 在同一仓库
6. **协议优先**: 先定义 Client ↔ Brain、Hand ↔ Brain 协议
7. **渐进式迁移**: 每阶段完成后系统可正常工作
8. **桌面保留本地模式**: NAS 不可达时回退本地 Brain
9. **Session 用 SQLite**: 并发安全，多客户端共享

## 与 Anthropic 模式的映射

| Anthropic | wzxClaw 实现 |
|-----------|-------------|
| Session (append-only) | NAS SQLite，所有客户端共享 |
| Harness (Brain) | NAS `packages/agent-server/` |
| Sandbox (Hands) | `packages/hand/` — 桌面/Docker/任意机器 |
| `execute(name, input) → string` | WebSocket `hand:execute` → `hand:result` |
| `provision({resources})` | Hand 启动注册，Brain 动态发现 |
| `wake(sessionId)` | Brain 无状态，从 SQLite 恢复 |
| Secure Proxy | Brain 管理 API Key，Hand 接触不到 |
| Many Hands | HandsRouter: 桌面 + Docker + 第三方 |
| Pets → Cattle | Brain 挂了重启恢复；Hand 挂了换一个 |

## Risks

| 风险 | 影响 | 缓解 |
|------|------|------|
| Brain 提取工作量大 | 耗时长 | 逐步提取，每步验证桌面正常 |
| WebView 性能不如 Flutter 原生渲染 | 手机端卡顿 | 聊天类 UI 对渲染要求不高，WebView 足够 |
| Capacitor 原生能力不够 | 缺少某些原生特性 | 聊天 App 需要的原生能力很少 |
| 协议设计不当 | 后期改动成本高 | 先写协议文档，评审后实现 |
| NAS 性能瓶颈 | Brain 处理慢 | Brain 只做编排，LLM 走 API |
| Hand 网络不稳定 | 工具执行中断 | 心跳 + 超时 + fallback |
| Session 数据迁移 | JSONL → SQLite | 迁移脚本 |

## Flutter 项目处理

迁移完成后 `wzxClaw_android/` 目录可归档或删除：
- Flutter 代码不再维护
- 新手机端完全由 `mobile/` (Capacitor) 替代
- 过渡期两个手机端可共存（一个连 Relay，一个连 Brain）
