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

将 wzxClaw 从当前的 Pet 模式（Brain + Hands + Session 全在桌面 Electron 进程中）
迁移为 Anthropic 的 Cattle 模式：

- **NAS 运行 Brain**（AgentLoop + LLM Gateway + Context + Session）
- **桌面端是客户端 + Hand #1**（操作 Windows 本地文件）
- **Docker 是 Hand #2**（桌面离线时手机独立使用）
- **手机是纯客户端**（直连 NAS Brain，不再经过桌面中转）
- **一个 Brain 可连接多个 Hand**（桌面、Docker、任何跑 `wzxclaw-hand` 的机器）

## 当前架构 → 目标架构

```
当前 (Pet 模式):

  手机 ──WSS──→ NAS Relay ──WSS──→ 桌面 Electron
                                      ├── Brain (AgentLoop)
                                      ├── Hands (25+ Tools)
                                      └── Session (JSONL)
                                      全部耦合在一个进程里


目标 (Cattle 模式):

  手机 ──WSS──→ NAS Brain ←──WSS──→ 桌面 Electron (客户端 + Hand #1)
                  │                        ├── UI 客户端 (聊天/流式)
                  │                        └── Hand (文件/终端/代码)
                  │
                  ├── Session (SQLite)
                  ├── Hands Router
                  │     ├── 桌面 Hand (Windows)
                  │     └── Docker Hand (NAS 本地)
                  │
                  └── LLM APIs

  任何机器:
  $ npx wzxclaw-hand --brain wss://5945.top/agent --token xxx
  → 注册为 Hand，Brain 可以在那台机器上执行工具
```

---

## 迁移路径（6 个阶段，顺序执行）

### 阶段 1: 提取 Brain 核心 — 脱离 Electron

**目标**: AgentLoop + LLM Gateway + Context 成为独立的 Node.js 包，不依赖 Electron

**产出**: `packages/brain/` — 可在 Node.js 环境独立运行的 Brain 核心

**文件**:
- `packages/brain/` (新建 monorepo 包)
- 从 `wzxClaw_desktop/src/main/` 提取:
  - `agent/agent-loop.ts` → `packages/brain/src/agent-loop.ts`
  - `agent/turn-manager.ts` → `packages/brain/src/turn-manager.ts`
  - `agent/stream-phase.ts` → `packages/brain/src/stream-phase.ts`
  - `agent/system-prompt-builder.ts` → `packages/brain/src/system-prompt-builder.ts`
  - `llm/` → `packages/brain/src/llm/` (gateway, adapters, retry, types)
  - `context/` → `packages/brain/src/context/` (context-manager, microcompact, token-counter)

**步骤**:
1. 初始化 `packages/brain/` 作为独立 TypeScript 包（tsconfig、package.json）
2. 复制 agent/、llm/、context/ 源文件，保留目录结构
3. 移除所有 Electron 依赖:
   - `ipc-main` / `ipc-renderer` → 删除或替换为事件接口
   - `BrowserWindow` → 删除
   - `safeStorage` → 替换为接口（加密由使用者注入）
   - `dialog` → 删除（UI 由客户端处理）
4. 定义 Brain 的核心接口:
   ```typescript
   // packages/brain/src/interfaces.ts
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
5. AgentLoop 构造函数改为依赖接口:
   ```typescript
   class AgentLoop {
     constructor(
       private streamProvider: IStreamProvider,
       private toolExecutor: IToolExecutor,
       private sessionStore: ISessionStore,
       private contextManager: ContextManager,
       options?: AgentLoopOptions
     )
   }
   ```
6. TurnManager 移除 `createExecuteToolFn()`，改为接收 `IToolExecutor`
7. 编写 Brain 包的单元测试（mock 接口）
8. 桌面端仍可正常使用 — 通过适配器桥接新旧接口

**验证**:
- `packages/brain/` 的 `npm test` 通过
- `packages/brain/` 无 Electron 依赖（`grep -r "electron" packages/brain/` 为空）
- 桌面端 Electron 通过适配器使用 Brain 包，功能不变

---

### 阶段 2: Agent 服务器 — NAS 部署

**目标**: Brain 包作为 WebSocket 服务器部署到 NAS Docker

**产出**: `packages/agent-server/` — 可 Docker 部署的 Agent 服务

**文件**:
- `packages/agent-server/` (新建)
  - `src/server.ts` — WebSocket + HTTP 服务器入口
  - `src/brain-instance.ts` — Brain 实例管理
  - `src/session-store-sqlite.ts` — SQLite 实现 ISessionStore（并发安全）
  - `src/client-handler.ts` — 客户端连接管理（桌面/手机）
  - `src/hands-router.ts` — Hand 注册、路由、健康检查
  - `src/auth.ts` — Token 认证（复用 relay 的 auth 逻辑）
  - `Dockerfile` — Docker 部署配置

**步骤**:
1. 创建 `packages/agent-server/` 包，依赖 `packages/brain`
2. 实现 WebSocket 服务器:
   - 两种连接类型: `client`（桌面/手机 UI）和 `hand`（工具执行者）
   - 客户端连接: 发消息 → 启动/恢复 AgentLoop → 流式返回事件
   - Hand 连接: 注册能力 → 接收工具调用请求 → 返回结果
3. 实现 `SessionStoreSqlite implements ISessionStore`:
   - SQLite WAL 模式支持并发读写
   - 数据存储在 NAS 持久卷
4. 实现 `HandsRouter`:
   ```typescript
   class HandsRouter {
     private hands: Map<string, HandConnection>  // handId → connection

     register(handId, capabilities, connection)   // Hand 上线注册
     unregister(handId)                           // Hand 下线
     execute(name, input, context): Promise<Result>  // 路由到合适的 Hand
     getAvailableHands(): HandInfo[]              // 查询可用 Hand
   }
   ```
5. 实现 `HandAwareToolExecutor implements IToolExecutor`:
   - `getDefinitions()`: 聚合所有在线 Hand 的工具定义
   - `execute()`: 根据工具类型路由到对应 Hand
   - 支持路由策略: 优先桌面 Hand → fallback Docker Hand
6. 认证: Token 验证，复用 relay 的 auth 模式
7. Docker 部署:
   - Dockerfile: Node.js 20 + agent-server
   - docker-compose: 映射端口、持久化 SQLite 卷
   - nginx 配置: `wss://5945.top/agent/` 代理到容器

**客户端协议 (Client ↔ Brain)**:
```
→ { event: "chat:send", data: { sessionId, message } }
← { event: "stream:text", data: { delta } }
← { event: "stream:tool_call", data: { name, input } }
← { event: "stream:tool_result", data: { output } }
← { event: "stream:done", data: { usage } }
← { event: "session:list", data: [...] }
```

**Hand 协议 (Hand ↔ Brain)**:
```
→ { event: "hand:register", data: { id, capabilities, definitions } }
← { event: "hand:execute", data: { callId, name, input } }
→ { event: "hand:result", data: { callId, output, isError } }
← { event: "hand:heartbeat", data: { status } }
```

**验证**:
- Docker 构建 + 启动成功
- 桌面通过 WebSocket 连接 NAS Brain，发送消息，收到流式回复
- Hand 注册成功，Brain 能路由工具调用
- SQLite Session 持久化，重启后可恢复

---

### 阶段 3: Hand 服务 — 独立 npm 包

**目标**: 创建 `wzxclaw-hand` 独立包，任何机器装上就能成为 Brain 的"手"

**产出**: `packages/hand/` — 独立 npm 包

**文件**:
- `packages/hand/`
  - `src/index.ts` — 入口，导出 `HandClient`
  - `src/hand-client.ts` — WebSocket 客户端，连接 Brain
  - `src/tool-runner.ts` — 本地工具执行（从桌面端提取）
  - `src/tools/` — 工具实现（FileRead, FileWrite, Bash, Grep, Glob...）
  - `bin/wzxclaw-hand.ts` — CLI 入口

**步骤**:
1. 创建 `packages/hand/` 包
2. 从桌面端 `src/main/tools/` 提取工具实现:
   - 文件工具: FileRead, FileWrite, FileEdit, MultiEdit
   - 搜索工具: Grep, Glob, LS, SemanticSearch
   - 终端工具: Bash
   - 通用工具: TodoWrite
   - 注意: 桌面专用工具（Browser, Electron 相关）不提取
3. 实现 `HandClient`:
   ```typescript
   class HandClient {
     constructor(config: {
       brainUrl: string,      // wss://5945.top/agent
       token: string,         // 认证
       workingDir: string,    // 工作目录
       capabilities?: string[] // 声明支持哪些工具
     })

     async start()   // 连接 Brain，注册 Hand，开始监听
     async stop()    // 断开连接
   }
   ```
4. 工具执行管线:
   - 收到 `hand:execute` → 查找本地工具 → 执行 → 返回 `hand:result`
   - 权限控制: Hand 本地维护权限配置（哪些工具自动批准）
   - 超时处理: 工具执行超时返回错误
5. CLI 入口:
   ```bash
   # 直接运行
   npx wzxclaw-hand --brain wss://5945.top/agent --token xxx --dir /path/to/project

   # 或全局安装
   npm install -g wzxclaw-hand
   wzxclaw-hand --brain wss://5945.top/agent --token xxx
   ```
6. 心跳保活: 每 30s 发 `hand:heartbeat`，Brain 检测离线

**验证**:
- `npx wzxclaw-hand` 在任意机器启动，连接 Brain
- Brain 的 Hands Router 显示新 Hand 注册
- 通过 NAS Brain 发消息，工具调用路由到 Hand，执行并返回结果

---

### 阶段 4: 桌面端改造 — 客户端 + 内置 Hand

**目标**: 桌面 Electron 连接 NAS Brain，同时内置 Hand 功能

**文件**:
- `wzxClaw_desktop/src/main/`
  - `brain-client.ts` (新建) — WebSocket 客户端，连接 NAS Brain
  - `hand-bridge.ts` (新建) — 桥接桌面工具到 Brain 的 Hand 协议
  - `index.ts` — 重构初始化逻辑
- `wzxClaw_desktop/src/renderer/` — UI 调整（连接状态、Hand 状态）

**步骤**:
1. **brain-client.ts**: WebSocket 客户端
   - 连接 NAS Brain (`wss://5945.top/agent/`)
   - 发送用户消息，接收流式事件
   - 转换流式事件为现有 IPC 事件格式 → Renderer 无感知变化
   - Session 管理代理（创建/加载/删除 → 全部转发 NAS Brain）
2. **hand-bridge.ts**: 桌面作为 Hand
   - 连接 NAS Brain，注册为 Hand
   - 声明能力: `["file-read", "file-write", "file-edit", "bash", "grep", "glob", ...]`
   - 收到 `hand:execute` → 调用本地 ToolRegistry → 返回结果
   - 复用桌面现有的全部 25+ 工具
3. **双连接架构**:
   ```
   Electron 启动
   ├── brain-client.connect()  → NAS Brain (客户端角色)
   │   └── 接管: 发消息、收流式、session 管理
   └── hand-bridge.connect()   → NAS Brain (Hand 角色)
       └── 注册: "hand-desktop" + 能力列表
   ```
4. **Renderer 无感知**:
   - Brain 返回的流式事件格式 → 转换为现有 IPC 格式
   - Renderer 代码基本不变（只改数据来源）
   - 新增: NAS 连接状态指示器（在线/离线）
   - 新增: Hand 状态面板（当前注册了哪些 Hand、在线状态）
5. **离线模式**:
   - NAS 不可达时，回退到本地 Brain（保留现有能力）
   - 本地模式: AgentLoop + LocalToolExecutor（不走 WebSocket）
   - 用户可切换: NAS Agent / 本地 Agent

**验证**:
- 桌面连接 NAS Brain，聊天功能正常
- 工具调用通过 Hand Bridge 路由到桌面本地执行
- 桌面操作的是 Windows 真实文件
- NAS 离线时自动回退本地模式

---

### 阶段 5: Docker Hand — NAS 本地沙箱

**目标**: NAS 上运行 Docker Hand，桌面离线时手机可独立使用

**文件**:
- `packages/hand-docker/` (新建)
  - `Dockerfile` — Hand + 基本开发环境
  - `docker-compose.yml` — 启动配置
  - `entrypoint.sh` — 启动 Hand，连接本地 Brain

**步骤**:
1. 基于 `packages/hand/` 创建 Docker 镜像:
   - 基础镜像: `node:20-slim`
   - 预装: git, python3, 基本编译工具
   - 工作目录: `/workspace`（NAS 挂载卷）
2. 启动时自动连接 NAS 本地 Brain:
   ```bash
   wzxclaw-hand --brain ws://localhost:8082 --token xxx --dir /workspace
   ```
3. Brain 的路由策略:
   ```typescript
   // hands-router.ts 路由逻辑
   function routeToolCall(name: string, context: ToolExecutionContext): string {
     // 如果用户在桌面项目工作区 → 优先桌面 Hand
     if (context.projectType === 'desktop' && desktopHand.online) {
       return 'hand-desktop'
     }
     // 桌面离线 或 NAS 项目 → Docker Hand
     return 'hand-docker'
   }
   ```
4. Docker Hand 的项目工作空间:
   - `/workspace/` 映射到 NAS 持久存储
   - 用户通过手机在 NAS 上创建/管理项目
   - 与桌面项目独立（两套文件系统）

**验证**:
- Docker Hand 启动，Brain 注册成功
- 手机发消息，Brain 路由到 Docker Hand，工具执行成功
- 关闭桌面后手机仍可独立使用 Agent

---

### 阶段 6: 手机端改造 — 直连 NAS Brain

**目标**: Flutter 手机端直连 NAS Brain，不再依赖桌面中转

**文件**:
- `wzxClaw_android/lib/`
  - `services/connection_manager.dart` — 改为连接 NAS Brain
  - `services/chat_store.dart` — 适配新协议
  - `services/hand_status_service.dart` (新建) — 显示 Hand 状态

**步骤**:
1. ConnectionManager 重构:
   - 当前: 连接 NAS Relay → 中转到桌面
   - 改为: 直连 NAS Brain WebSocket
   - 协议从 relay 自定义协议 → Brain 客户端协议
2. ChatStore 适配:
   - 发送: `{ event: "chat:send", data: { sessionId, message } }`
   - 接收: 处理 `stream:text`、`stream:tool_call`、`stream:tool_result`、`stream:done`
   - Session CRUD: 通过 Brain 协议，不再需要桌面代理
3. 新增 Hand 状态展示:
   - 显示当前注册的 Hand 列表（桌面 Hand 在线/离线、Docker Hand 状态）
   - 用户知道工具将在哪里执行
4. 移除对桌面的依赖:
   - 不再需要 `session:*` 中转事件
   - 不再需要 `command:send` → 桌面代理
   - 直接与 Brain 通信

**验证**:
- 手机直连 NAS Brain，聊天、工具调用正常
- 桌面在线时: 手机任务路由到桌面 Hand
- 桌面离线时: 手机任务路由到 Docker Hand
- Session 在桌面和手机之间共享

---

## 整体依赖链

```
阶段 1: 提取 Brain 核心 (脱离 Electron)
  │
  ▼
阶段 2: Agent 服务器 (NAS 部署 + WebSocket + Session)
  │
  ├──→ 阶段 3: Hand 服务 (独立 npm 包) ──→ 阶段 5: Docker Hand
  │                                          │
  ├──→ 阶段 4: 桌面端改造 (客户端 + Hand)     │
  │                                          │
  └──────────────────────────────────────────┘
                     │
                     ▼
              阶段 6: 手机端改造 (直连 NAS)
```

## 与 Anthropic 模式的映射

| Anthropic | wzxClaw 实现 |
|-----------|-------------|
| Session (append-only) | NAS SQLite，所有客户端共享 |
| Harness (Brain) | NAS 上的 `packages/agent-server/` |
| Sandbox (Hands) | `packages/hand/` — 可在任何机器运行 |
| `execute(name, input) → string` | WebSocket `hand:execute` → Hand 执行 → `hand:result` |
| `provision({resources})` | Hand 启动时注册，Brain 动态发现 |
| `wake(sessionId)` | Brain 无状态，从 SQLite Session 恢复上下文 |
| Secure Proxy | Brain 管理 API Key，Hand 接触不到 |
| Many Hands | HandsRouter: 桌面 Hand + Docker Hand + 任意第三方 |
| Pets → Cattle | Brain 挂了重启 + 恢复；Hand 挂了换一个 |

## 关键决策

1. **monorepo 结构**: `packages/brain/`、`packages/hand/`、`packages/agent-server/` 在同一仓库
2. **协议优先**: 先定义 Brain ↔ Client、Brain ↔ Hand 的 WebSocket 协议，再实现
3. **渐进式迁移**: 每个阶段完成后系统都可正常工作
4. **桌面保留本地模式**: NAS 不可达时回退到本地 Brain + Local Hands
5. **Session 用 SQLite**: 并发安全，比 JSONL 更适合多客户端共享
6. **Hand 权限本地管理**: 每个 Hand 自己决定哪些操作需要审批

## Risks

| 风险 | 影响 | 缓解 |
|------|------|------|
| Brain 从 Electron 提取工作量大 | 耗时长、易出错 | 逐步提取，每步验证桌面功能正常 |
| WebSocket 协议设计不当 | 后期改动成本高 | 先设计协议文档，评审后再实现 |
| NAS 性能瓶颈 | LLM API 延迟 + Brain 处理慢 | Brain 只做编排，LLM 调用仍走 API |
| Hand 网络不稳定 | 工具执行中断 | 心跳检测 + 超时重试 + fallback Hand |
| 桌面端双连接复杂 | 状态管理、错误处理 | 两个连接独立管理，互不影响 |
| Session 数据迁移 | 现有 JSONL → SQLite | 提供迁移脚本 |

## 未来扩展 (不在本次迁移)

- **任意机器注册 Hand**: `npx wzxclaw-hand` 一行命令
- **Hand 市场**: 预定义 Hand 模板（服务器、IoT、CI Runner）
- **跨 Brain 协作**: 多个 Brain 共享 Session
- **凭证代理**: API Key 不进入 Hand 执行环境
- **Hand 能力协商**: Hand 动态上报能力，Brain 自动适配工具列表
