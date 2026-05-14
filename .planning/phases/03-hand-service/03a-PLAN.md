---
phase: 03-hand-service
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/hand/package.json
  - packages/hand/tsconfig.json
  - packages/hand/vitest.config.ts
  - packages/hand/src/types.ts
  - packages/hand/src/protocol.ts
  - packages/hand/src/protocol.test.ts
  - packages/hand/src/connection.ts
  - packages/hand/src/connection.test.ts
autonomous: true
requirements: [HAND-01, HAND-02, HAND-03]

must_haves:
  truths:
    - "Hand 可以连接到 agent-server WebSocket 并发送 hand:register"
    - "Hand 收到 hand:execute 后执行工具并返回 hand:result"
    - "Hand 定期发送心跳并处理断连重连"
    - "所有协议消息格式与 agent-server 期望一致"
  artifacts:
    - path: "packages/hand/src/types.ts"
      provides: "Hand 类型定义：HandConfig, HandStatus, 握手消息类型"
    - path: "packages/hand/src/protocol.ts"
      provides: "协议编解码：消息序列化/反序列化，register/execute/result/heartbeat 消息构造"
      exports: ["createRegisterMessage", "createResultMessage", "createHeartbeatMessage", "parseIncomingMessage"]
    - path: "packages/hand/src/connection.ts"
      provides: "WebSocket 连接管理：连接、认证、注册、心跳、断连重连"
      exports: ["HandConnection"]
  key_links:
    - from: "packages/hand/src/connection.ts"
      to: "packages/agent-server/src/server.ts"
      via: "WebSocket ?type=hand query param + Sec-WebSocket-Protocol token"
      pattern: "type=hand.*token"
    - from: "packages/hand/src/connection.ts"
      to: "packages/hand/src/protocol.ts"
      via: "消息构造和解析函数"
      pattern: "create.*Message|parse.*Message"
---

<objective>
Hand 服务包脚手架 + WebSocket 协议层 + 连接管理

Purpose: 建立独立 npm 包的基础结构，实现与 agent-server 的完整 Hand 协议通信层，包括注册、心跳、重连机制。
Output: packages/hand/ 可构建的 npm 包，协议层和连接层经过完整测试覆盖。
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/03-hand-service/03-CONTEXT.md
@packages/agent-server/src/types.ts
@packages/agent-server/src/hands-router.ts
@packages/agent-server/src/server.ts
@packages/agent-server/package.json
@packages/agent-server/tsconfig.json
@packages/agent-server/vitest.config.ts

<interfaces>
<!-- executor 需要的 agent-server 协议契约 -->

From packages/agent-server/src/server.ts handleHandConnection:
- Server expects: hand:register { id, capabilities, definitions[] }, hand:result { callId, output, isError }, hand:heartbeat
- Server sends: hand:execute { callId, name, input, context }, hand:heartbeat_ack
- Connection URL: ws://host:port/?type=hand, token via Sec-WebSocket-Protocol header "wzxclaw-{token}" or ?token= query param

From packages/agent-server/src/hands-router.ts:
```typescript
interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  isReadOnly?: boolean
}
```

From packages/brain/src/interfaces.ts:
```typescript
interface IToolExecutionContext {
  workingDirectory: string
  projectRoots: string[]
  abortSignal: AbortSignal
}
interface IToolExecutionResult {
  output: string
  isError: boolean
}
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: 包脚手架 + 协议层类型和编解码</name>
  <files>packages/hand/package.json, packages/hand/tsconfig.json, packages/hand/vitest.config.ts, packages/hand/src/types.ts, packages/hand/src/protocol.ts, packages/hand/src/protocol.test.ts</files>
  <behavior>
    - createRegisterMessage 构造 { event: "hand:register", data: { id, capabilities, definitions } }
    - createResultMessage 构造 { event: "hand:result", data: { callId, output, isError } }
    - createHeartbeatMessage 构造 { event: "hand:heartbeat" }
    - parseIncomingMessage 解析合法 JSON 返回 { event, data }，非法 JSON 返回 null
    - parseIncomingMessage 识别 hand:execute 消息并提取 callId/name/input/context
    - parseIncomingMessage 识别 hand:heartbeat_ack 消息
  </behavior>
  <action>
    创建 packages/hand/ 包脚手架，遵循 agent-server 的完全相同模式：
    - package.json: name "@wzxclaw/hand", type "module", ESM exports, vitest 脚本, 依赖 ws
    - tsconfig.json: 复用 agent-server 配置 (ES2022, NodeNext, strict, exclude test files)
    - vitest.config.ts: environment node, include src/**/*.test.ts

    src/types.ts 定义：
    - HandConfig: { serverUrl: string, authToken: string, handId?: string, heartbeatIntervalMs?: number, reconnectBaseMs?: number }
    - HandStatus: enum 枚举 (disconnected, connecting, registering, connected, reconnecting)
    - IncomingExecuteMessage: { event: "hand:execute", data: { callId, name, input, context } }
    - IncomingHeartbeatAck: { event: "hand:heartbeat_ack" }
    - IncomingMessage: IncomingExecuteMessage | IncomingHeartbeatAck | { event: string, data?: unknown }
    - HandToolDefinition: { name, description, inputSchema, isReadOnly? }

    src/protocol.ts 实现：
    - createRegisterMessage(handId, capabilities, definitions) — 序列化为 JSON 字符串
    - createResultMessage(callId, output, isError) — 序列化为 JSON 字符串
    - createHeartbeatMessage() — 序列化为 JSON 字符串
    - parseIncomingMessage(raw: string) — 反序列化并返回类型化的 IncomingMessage 或 null

    src/protocol.test.ts 覆盖上述所有行为用例。注意 parseIncomingMessage 必须处理空字符串、非 JSON、缺少 event 字段等边界情况。

    使用 agent-server 相同的测试模式：vitest + describe/it/expect，mockWs 辅助函数。
  </action>
  <verify>
    <automated>cd E:/ai/wzxClaw/packages/hand && npx vitest run src/protocol.test.ts</automated>
  </verify>
  <done>protocol.test.ts 全部通过，tsc --noEmit 无错误</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: HandConnection — WebSocket 连接管理 + 注册 + 心跳 + 重连</name>
  <files>packages/hand/src/connection.ts, packages/hand/src/connection.test.ts</files>
  <behavior>
    - connect() 打开 WebSocket 到 serverUrl?type=hand，Sec-WebSocket-Protocol 头携带 token
    - 连接建立后自动发送 hand:register 消息
    - 收到 hand:execute 时触发 onExecute 回调
    - 收到 hand:heartbeat_ack 时更新内部心跳状态
    - sendResult(callId, output, isError) 发送 hand:result 消息
    - startHeartbeat() 启动定时心跳，stopHeartbeat() 停止
    - 连接断开时自动触发 onDisconnect 回调并启动指数退避重连
    - disconnect() 主动关闭连接，不触发重连
    - getStatus() 返回当前 HandStatus
  </behavior>
  <action>
    实现 HandConnection 类，管理 Hand 与 agent-server 的完整 WebSocket 生命周期。

    构造函数接收 HandConfig 和回调：
    - onExecute?: (data: { callId, name, input, context }) => void — 收到工具执行请求
    - onDisconnect?: () => void — 连接断开（非主动关闭）
    - onStatusChange?: (status: HandStatus) => void — 状态变更通知

    connect() 方法：
    1. 创建 WebSocket(url?type=hand, { headers: { 'Sec-WebSocket-Protocol': 'wzxclaw-' + token } })
    2. 状态 → connecting
    3. ws.on('open') → 发送 hand:register，状态 → registering → connected
    4. ws.on('message') → parseIncomingMessage，分发到 onExecute 回调或更新心跳状态
    5. ws.on('close') → 状态 → disconnected，触发 onDisconnect，启动 reconnect 逻辑
    6. ws.on('error') → 记录错误，状态 → disconnected

    startHeartbeat() 方法：
    - 使用 setInterval 每隔 heartbeatIntervalMs（默认 15000ms）发送 hand:heartbeat
    - stopHeartbeat() 清除 interval

    reconnect 逻辑：
    - 使用 setTimeout 实现指数退避：baseMs * 2^attempt，最大 30000ms
    - 每次重连尝试调用 connect()
    - 最多重试 10 次，超过后停止（手动 disconnect 可中断）
    - 成功连接后重置退避计数

    sendResult() 方法：
    - 检查连接状态为 connected 才发送
    - 使用 protocol.createResultMessage 构造消息

    disconnect() 方法：
    - stopHeartbeat()
    - ws.close(1000, 'hand disconnect')
    - 状态 → disconnected，设置 flag 阻止重连

    测试使用 MockWebSocket（参考 agent-server 测试中的 mockWs 模式）：
    - 不使用真实 WebSocket，而是创建 MockWebSocket 类模拟 open/message/close/error 事件
    - HandConnection 构造函数接受可选的 WebSocket factory 参数用于测试注入

    connection.test.ts 覆盖：
    - connect 建立连接并发送 register
    - 收到 hand:execute 触发 onExecute 回调
    - sendResult 发送正确格式的 hand:result
    - 心跳定时器启动和停止
    - 断连后自动重连（验证 reconnect 逻辑）
    - disconnect 不触发重连
    - 状态变更通知
  </action>
  <verify>
    <automated>cd E:/ai/wzxClaw/packages/hand && npx vitest run src/connection.test.ts</automated>
  </verify>
  <done>connection.test.ts 全部通过，HandConnection 实现完整的连接、注册、心跳、重连逻辑</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Hand → agent-server | Hand 发起 WebSocket 连接，需要 token 认证 |
| agent-server → Hand | 服务器可能发送 hand:execute，Hand 必须验证消息格式 |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03a-01 | S | connection.ts | mitigate | Token 通过 Sec-WebSocket-Protocol 头传输，服务器验证后才允许注册 |
| T-03a-02 | T | protocol.ts parseIncomingMessage | mitigate | 严格验证传入消息格式，无效消息返回 null 而非抛异常，防止恶意输入导致崩溃 |
| T-03a-03 | D | connection.ts heartbeat | mitigate | 心跳机制确保连接活性，30s 服务器超时内以 15s 间隔发送 |
| T-03a-04 | I | connection.ts reconnect | accept | 重连使用相同 token，不暴露额外信息。低风险——Hand 在受信任网络运行 |
</threat_model>

<verification>
cd E:/ai/wzxClaw/packages/hand && npx vitest run
cd E:/ai/wzxClaw/packages/hand && npx tsc --noEmit
</verification>

<success_criteria>
- packages/hand/package.json, tsconfig.json, vitest.config.ts 存在且格式正确
- packages/hand/src/types.ts 导出 HandConfig, HandStatus, IncomingMessage 等类型
- packages/hand/src/protocol.ts 导出消息构造和解析函数
- packages/hand/src/connection.ts 导出 HandConnection 类
- 所有测试通过，tsc 编译无错误
- 协议消息格式与 agent-server server.ts handleHandConnection 期望的格式完全一致
</success_criteria>

<output>
After completion, create `.planning/phases/03-hand-service/03a-SUMMARY.md`
</output>
