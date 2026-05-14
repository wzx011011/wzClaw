---
phase: 02-agent-server
plan: 02c
type: execute
wave: 3
depends_on: [02a, 02b]
files_modified:
  - packages/agent-server/src/client-handler.ts
  - packages/agent-server/src/server.ts
  - packages/agent-server/src/server.test.ts
  - packages/agent-server/src/index.ts
  - packages/agent-server/Dockerfile
  - packages/agent-server/nginx/agent.conf
autonomous: false
requirements: []

user_setup:
  - service: NAS nginx
    why: "添加 /agent/ 反向代理路由"
    env_vars: []
    dashboard_config:
      - task: "将 nginx/agent.conf 配置添加到 NAS nginx"
        location: "NAS nginx 配置目录，添加 /agent/ location 块反代到 127.0.0.1:8082"
  - service: NAS Docker
    why: "部署 agent-server 容器"
    env_vars:
      - name: AUTH_TOKEN
        source: "与 relay 共用同一个 token"
    dashboard_config:
      - task: "构建 Docker 镜像并启动容器"
        location: "NAS Docker，映射端口 8082，挂载 /volume1/wzxclaw/data 为数据库持久卷"

must_haves:
  truths:
    - "WebSocket 客户端连接后可发送 chat:send 消息并收到流式回复"
    - "Agent 事件通过 WebSocket 实时推送给客户端"
    - "Hand 连接后可注册，Brain 可路由工具调用"
    - "HTTP /health 端点返回服务状态"
    - "Docker 构建成功，容器启动无报错"
  artifacts:
    - path: "packages/agent-server/src/client-handler.ts"
      provides: "客户端 WebSocket 连接处理 + AgentLoop 桥接"
      exports: ["ClientHandler"]
    - path: "packages/agent-server/src/server.ts"
      provides: "HTTP + WebSocket 服务器入口"
      exports: ["AgentServer"]
    - path: "packages/agent-server/src/server.test.ts"
      provides: "集成测试"
    - path: "packages/agent-server/Dockerfile"
      provides: "Docker 部署配置"
    - path: "packages/agent-server/nginx/agent.conf"
      provides: "nginx 反向代理配置"
  key_links:
    - from: "packages/agent-server/src/server.ts"
      to: "packages/agent-server/src/client-handler.ts"
      via: "创建 ClientHandler 处理 client 类型连接"
      pattern: "new ClientHandler"
    - from: "packages/agent-server/src/client-handler.ts"
      to: "packages/brain/src/agent/agent-loop.ts"
      via: "调用 AgentLoop.run() 消费 AsyncGenerator<AgentEvent>"
      pattern: "AgentLoop|createAgentLoop"
    - from: "packages/agent-server/src/server.ts"
      to: "packages/agent-server/src/hands-router.ts"
      via: "创建 HandsRouter 处理 hand 类型连接"
      pattern: "new HandsRouter"
    - from: "packages/agent-server/src/client-handler.ts"
      to: "packages/agent-server/src/hand-aware-tool-executor.ts"
      via: "注入 HandAwareToolExecutor 作为 AgentLoop 的工具执行器"
      pattern: "HandAwareToolExecutor"
---

<objective>
实现 WebSocket 服务器入口、客户端连接处理、Docker 部署配置。

Purpose: 将前面的基础设施（auth、session、hands）集成到可运行的 WebSocket 服务器中。客户端连接后可通过 chat:send 触发 AgentLoop，流式接收 Agent 事件。Hand 连接后注册到 HandsRouter，工具调用被正确路由。
Output: 可 Docker 部署的 agent-server，`wss://5945.top/agent/` 可用。
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/02-agent-server/02a-SUMMARY.md
@.planning/phases/02-agent-server/02b-SUMMARY.md

<interfaces>
<!-- Brain 包 AgentLoop 工厂 -->

From packages/brain/src/agent/agent-factory.ts:
```typescript
export interface AgentLoopDeps {
  gateway: IStreamProvider
  contextManager: IContextManager
  observability?: IObservability
  hookRegistry?: IHookRegistry
  logger?: ILogger
}

export function createAgentLoop(deps: AgentLoopDeps): AgentLoop
```

From packages/brain/src/agent/agent-loop.ts:
```typescript
class AgentLoop {
  async *run(
    userMessage: string,
    config: AgentConfig,
    sender?: IEventSender,
    toolExecutor?: IToolExecutor,
  ): AsyncGenerator<AgentEvent>
  cancel(): void
  getMessages(): Message[]
}
```

From packages/brain/src/agent/types.ts:
```typescript
export type AgentEvent =
  | AgentTextEvent        // { type: 'agent:text', content }
  | AgentThinkingEvent    // { type: 'agent:thinking', content }
  | AgentToolCallEvent    // { type: 'agent:tool_call', toolCallId, toolName, input }
  | AgentToolResultEvent  // { type: 'agent:tool_result', toolCallId, toolName, output, isError }
  | AgentErrorEvent       // { type: 'agent:error', error, recoverable }
  | AgentDoneEvent        // { type: 'agent:done', usage, turnCount, model }
  | AgentCompactedEvent   // { type: 'agent:compacted', beforeTokens, afterTokens, auto }
  // ...
```

From packages/brain/src/interfaces.ts:
```typescript
export interface IEventSender {
  send(channel: string, data: unknown): void
  isDestroyed?(): boolean
}
```

Client 协议:
```
→ chat:send          { sessionId, message }
← stream:text        { delta }
← stream:tool_call   { name, input }
← stream:tool_result { output }
← stream:done        { usage }
← session:list       [...]
```

Hand 协议:
```
→ hand:register      { id, capabilities, definitions }
← hand:execute       { callId, name, input }
→ hand:result        { callId, output, isError }
← hand:heartbeat     { status }
```
</interfaces>

<!-- 参考现有 relay server.js 入口模式 -->
@relay/server.js
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: ClientHandler — 客户端连接处理 + AgentLoop 桥接</name>
  <files>
    packages/agent-server/src/client-handler.ts,
    packages/agent-server/src/client-handler.test.ts,
    packages/agent-server/src/index.ts
  </files>
  <behavior>
    - 收到 { event: "chat:send", data: { sessionId, message } } 后启动 AgentLoop.run()
    - AgentLoop 产出 agent:text → 发送 { event: "stream:text", data: { delta } }
    - AgentLoop 产出 agent:tool_call → 发送 { event: "stream:tool_call", data: { name, input } }
    - AgentLoop 产出 agent:tool_result → 发送 { event: "stream:tool_result", data: { output } }
    - AgentLoop 产出 agent:done → 发送 { event: "stream:done", data: { usage, turnCount } }
    - AgentLoop 产出 agent:error → 发送 { event: "stream:error", data: { error } }
    - 收到 { event: "session:list" } → 从 SessionStore 获取列表发送回客户端
    - 收到 { event: "session:load", data: { sessionId } } → 加载历史消息
    - 收到 { event: "session:create" } → 创建新会话
    - 收到 { event: "session:delete", data: { sessionId } } → 删除会话
    - WebSocket 关闭时取消正在运行的 AgentLoop
    - 同一客户端同时只运行一个 AgentLoop（新请求取消旧的）
  </behavior>
  <read_first>
    packages/brain/src/agent/agent-loop.ts,
    packages/brain/src/agent/agent-factory.ts,
    packages/brain/src/agent/types.ts,
    packages/brain/src/interfaces.ts,
    packages/agent-server/src/session-sqlite.ts,
    packages/agent-server/src/hand-aware-tool-executor.ts
  </read_first>
  <action>
    1. 创建 src/client-handler.ts。

    2. ClientHandler 类:
       - 构造函数参数: sessionStore: ISessionStore, toolExecutor: HandAwareToolExecutor, createLoop: () => AgentLoop（工厂函数，延迟创建）
       - 管理 client WebSocket 连接

    3. handleConnection(ws):
       - 存储 ws 引用
       - 监听 ws 'message' 事件，解析 JSON，按 event 分发
       - 监听 ws 'close' 事件，取消活跃的 AgentLoop
       - 创建 WebSocketEventSender implements IEventSender（适配 brain 接口）:
         - send(channel, data): 将 AgentEvent 转换为 Client 协议格式发送
         - isDestroyed(): ws.readyState !== 1

    4. AgentEvent → Client 协议映射:
       - agent:text → { event: "stream:text", data: { delta: event.content } }
       - agent:thinking → { event: "stream:thinking", data: { content: event.content } }
       - agent:tool_call → { event: "stream:tool_call", data: { toolCallId: event.toolCallId, name: event.toolName, input: event.input } }
       - agent:tool_result → { event: "stream:tool_result", data: { toolCallId: event.toolCallId, name: event.toolName, output: event.output, isError: event.isError } }
       - agent:error → { event: "stream:error", data: { error: event.error, recoverable: event.recoverable } }
       - agent:done → { event: "stream:done", data: { usage: event.usage, turnCount: event.turnCount } }
       - agent:compacted → { event: "stream:compacted", data: { beforeTokens, afterTokens } }

    5. chat:send 处理:
       - 如果已有活跃 AgentLoop，先 cancel()
       - 创建新 AgentLoop（通过工厂函数）
       - 如果 sessionStore 有历史消息，先 loadSession + replaceMessages
       - 调用 loop.run(message, config, sender, toolExecutor)
       - 消费 AsyncGenerator，每个 event 通过 sender 发送
       - run 完成后，将新消息 appendMessage 到 sessionStore

    6. session 操作:
       - session:list → 调用 sessionStore.listSessions()，发送 { event: "session:list", data: [...] }
       - session:load → 调用 sessionStore.loadSession(sessionId)，发送 { event: "session:loaded", data: { messages } }
       - session:create → 生成新 sessionId，发送 { event: "session:created", data: { sessionId } }
       - session:delete → 调用 sessionStore.deleteSession(sessionId)，发送 { event: "session:deleted", data: { sessionId } }

    7. 编写 client-handler.test.ts:
       - mock AgentLoop（返回预设事件的 AsyncGenerator）
       - mock SessionStore
       - mock WebSocket
       - 验证 AgentEvent 到 Client 协议的映射
       - 验证 session 操作
       - 验证 WebSocket 关闭时取消 AgentLoop

    8. 更新 src/index.ts 导出 ClientHandler。
  </action>
  <verify>
    <automated>cd packages/agent-server && npx vitest run src/client-handler.test.ts</automated>
  </verify>
  <done>
    - ClientHandler 正确处理所有 Client 协议消息
    - AgentEvent 正确映射为 Client 协议事件
    - session CRUD 通过 WebSocket 可用
    - WebSocket 关闭时清理 AgentLoop
    - 所有测试通过
  </done>
</task>

<task type="auto">
  <name>Task 2: 服务器入口 + Docker + nginx</name>
  <files>
    packages/agent-server/src/server.ts,
    packages/agent-server/src/server.test.ts,
    packages/agent-server/Dockerfile,
    packages/agent-server/nginx/agent.conf,
    packages/agent-server/src/index.ts
  </files>
  <read_first>
    relay/server.js,
    relay/Dockerfile,
    packages/agent-server/src/auth.ts,
    packages/agent-server/src/session-sqlite.ts,
    packages/agent-server/src/hands-router.ts,
    packages/agent-server/src/hand-aware-tool-executor.ts,
    packages/agent-server/src/client-handler.ts
  </read_first>
  <action>
    1. 创建 src/server.ts — 主服务器入口。

    2. AgentServer 类:
       - 构造函数参数: config: ServerConfig
       - 初始化:
         a. initAuth(config.authToken)
         b. new SessionStoreSqlite(config.dbPath)
         c. new HandsRouter()
         d. new HandAwareToolExecutor(handsRouter)
         e. new ClientHandler(sessionStore, toolExecutor, () => createAgentLoop({...}))
       - createHttpServer(): 创建 HTTP server，/health 端点返回 { status: "ok", hands: count, uptime }
       - createWss(server): 创建 WebSocketServer
       - wss.on('connection', ws, req):
         a. 提取 token（Sec-WebSocket-Protocol header 或 query string） — 复用 relay server.js 的提取逻辑
         b. authenticate(token)
         c. 提取 connection type: reqUrl.searchParams.get('type') — 'client' 或 'hand'
         d. type='client' → clientHandler.handleConnection(ws)
         e. type='hand' → handleHandConnection(ws)
       - handleHandConnection(ws):
         a. 监听 message，解析 hand:register → handsRouter.register()
         b. 监听 message，解析 hand:result → toolExecutor.handleResult()
         c. 监听 message，解析 hand:heartbeat → handsRouter.updateHeartbeat() + 回复 pong
         d. 监听 close → handsRouter.unregister() + toolExecutor.handleHandDisconnect()
       - start(): 启动 HTTP server 监听
       - stop(): 优雅关闭

    3. 模块级 main 函数:
       - 从环境变量读取配置: PORT (8082), AUTH_TOKEN, DB_PATH
       - 创建 AgentServer 实例并启动
       - 注册 SIGTERM/SIGINT 处理

    4. 编写 server.test.ts:
       - 测试 HTTP /health 端点
       - 测试 WebSocket 连接认证拒绝
       - 测试 client/hand 路由分发
       - 使用真实 HTTP server + WebSocket client（vitest 内 ws 库）

    5. 创建 Dockerfile:
       - 基于 relay/Dockerfile 模式（node:20-alpine 两阶段）
       - Stage 1: 安装依赖（需要 python3 + make + g++ 因为 better-sqlite3 有 native binding）
       - Stage 2: 复制 node_modules + 源码
       - EXPOSE 8082
       - CMD ["node", "dist/server.js"] — 注意: 需要 build 步骤
       - 实际: CMD ["node", "--experimental-vm-modules", "src/server.ts"] — 或者用 tsx
       - 推荐方案: 在 Dockerfile 中增加 tsc build 步骤，然后 CMD ["node", "dist/server.js"]

    6. 创建 nginx/agent.conf:
       - 参考 relay 现有的 nginx 配置模式
       - location /agent/ 反向代理到 127.0.0.1:8082
       - WebSocket upgrade 头: Upgrade, Connection
       - proxy_pass http://127.0.0.1:8082/
       - proxy_http_version 1.1
       - proxy_set_header Upgrade $http_upgrade
       - proxy_set_header Connection "upgrade"
       - proxy_read_timeout 3600s（长连接）

    7. 更新 src/index.ts 导出 AgentServer。

    8. 添加 server 启动脚本到 package.json scripts:
       - "start": "node dist/server.js"
       - "dev": "npx tsx src/server.ts"
       - "build": "tsc"
  </action>
  <verify>
    <automated>cd packages/agent-server && npx vitest run src/server.test.ts</automated>
  </verify>
  <done>
    - AgentServer 启动后 HTTP /health 返回 200
    - WebSocket 客户端可通过 type=client 连接
    - WebSocket Hand 可通过 type=hand 连接并注册
    - 无效 token 连接被拒绝
    - Dockerfile 构建无错误
    - nginx 配置正确配置 WebSocket 反向代理
    - 所有测试通过
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Internet → nginx | 外部流量通过 nginx 反代 |
| nginx → agent-server | 内网 WebSocket，Token 认证 |
| client → AgentLoop | 用户消息触发 LLM 调用（费用风险） |
| Hand → 工具执行 | Hand 执行结果可能包含敏感信息 |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02c-01 | S | WebSocket connection | mitigate | Token 认证，timing-safe 比较 |
| T-02c-02 | D | AgentLoop.run | mitigate | MAX_AGENT_TURNS 安全天花板 |
| T-02c-03 | E | chat:send | mitigate | 单连接单 AgentLoop，并发取消旧的 |
| T-02c-04 | I | hand:result | accept | 单用户环境，Hand 结果不做完整性校验 |
| T-02c-05 | D | Docker | mitigate | USER node 非 root 运行 |
| T-02c-06 | T | /health | accept | 仅返回 status/uptime，无敏感数据 |
</threat_model>

<verification>
```bash
cd packages/agent-server
npm install
npx tsc --noEmit
npx vitest run
```
</verification>

<success_criteria>
- AgentServer 可启动，/health 返回 200
- Client WebSocket 连接 → chat:send → 收到 stream:text/done 事件
- Hand WebSocket 连接 → hand:register → HandsRouter 注册成功
- 无效 Token 被拒绝（close 4001）
- Dockerfile 构建成功
- nginx agent.conf 配置正确
</success_criteria>

<output>
After completion, create `.planning/phases/02-agent-server/02c-SUMMARY.md`
</output>
