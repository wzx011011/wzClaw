---
phase: 02-agent-server
plan: 02b
type: execute
wave: 2
depends_on: [02a]
files_modified:
  - packages/agent-server/src/hands-router.ts
  - packages/agent-server/src/hand-aware-tool-executor.ts
  - packages/agent-server/src/hand-aware-tool-executor.test.ts
  - packages/agent-server/src/index.ts
autonomous: true
requirements: []

must_haves:
  truths:
    - "Hand 连接后可注册其工具定义到 HandsRouter"
    - "Hand 离线后，其工具从可用列表中移除"
    - "HandAwareToolExecutor 聚合所有在线 Hand 的工具定义返回给 AgentLoop"
    - "工具调用被路由到声明了该工具的 Hand 执行"
    - "Hand 未返回结果时超时有 fallback"
    - "多个 Hand 注册同名工具时路由到优先级最高的 Hand"
  artifacts:
    - path: "packages/agent-server/src/hands-router.ts"
      provides: "Hand 注册、路由、健康检查、移除"
      exports: ["HandsRouter", "HandEntry"]
    - path: "packages/agent-server/src/hand-aware-tool-executor.ts"
      provides: "IToolExecutor 实现，路由工具调用到在线 Hand"
      exports: ["HandAwareToolExecutor"]
    - path: "packages/agent-server/src/hand-aware-tool-executor.test.ts"
      provides: "单元测试"
  key_links:
    - from: "packages/agent-server/src/hand-aware-tool-executor.ts"
      to: "packages/brain/src/interfaces.ts"
      via: "implements IToolExecutor"
      pattern: "implements IToolExecutor"
    - from: "packages/agent-server/src/hand-aware-tool-executor.ts"
      to: "packages/agent-server/src/hands-router.ts"
      via: "调用 HandsRouter 查找 Hand"
      pattern: "handsRouter\\.(findHand|getAll)"
---

<objective>
实现 Hand 路由层：HandsRouter 管理 Hand 连接注册/移除/健康检查，HandAwareToolExecutor 聚合在线 Hand 工具并路由执行。

Purpose: Brain 需要知道哪些 Hand 在线、它们能执行什么工具。当 AgentLoop 产生工具调用时，HandAwareToolExecutor 找到对应的 Hand，通过 WebSocket 发送 hand:execute，等待 hand:result 返回。
Output: 完整的 Hand 路由 + 工具执行层，可独立测试。
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

<interfaces>
<!-- Brain 包 IToolExecutor 接口 — HandAwareToolExecutor 必须实现 -->

From packages/brain/src/interfaces.ts:
```typescript
export interface IToolExecutor {
  execute(name: string, input: Record<string, unknown>, context: IToolExecutionContext): Promise<IToolExecutionResult>
  getDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  isReadOnly(toolName: string): boolean
}

export interface IToolExecutionContext {
  workingDirectory: string
  projectRoots: string[]
  abortSignal: AbortSignal
  workspaceId?: string
  langfuseParentSpan?: unknown
  onSubAgentEvent?: (event: Record<string, unknown>) => void
}

export interface IToolExecutionResult {
  output: string
  isError: boolean
}
```

From packages/agent-server/src/types.ts (Plan 02a 创建):
```typescript
interface HandConnection {
  ws: WebSocket
  id: string
  capabilities: string[]     // 该 Hand 支持的工具名列表
  definitions: ToolDef[]     // 完整工具定义（name, description, inputSchema, isReadOnly）
  lastHeartbeat: number
}
```

Hand 协议:
```
→ hand:register      { id, capabilities, definitions }
← hand:execute       { callId, name, input }
→ hand:result        { callId, output, isError }
← hand:heartbeat     { status }
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: HandsRouter — Hand 注册、路由、健康检查</name>
  <files>
    packages/agent-server/src/hands-router.ts,
    packages/agent-server/src/hands-router.test.ts,
    packages/agent-server/src/index.ts
  </files>
  <behavior>
    - register(hand) 添加 Hand 到路由表，getHandCount() 增加
    - unregister(handId) 移除 Hand，getHandCount() 减少
    - findHand("FileRead") 返回注册了 FileRead 工具的 Hand
    - findHand("不存在") 返回 null
    - 多个 Hand 注册同名工具时返回优先级高的（先注册的优先）
    - getAllDefinitions() 返回所有在线 Hand 的工具定义（去重，先注册优先）
    - getHandById(handId) 返回指定 Hand
    - 30s 心跳超时标记 Hand 为不健康，findHand 不返回不健康的 Hand
  </behavior>
  <read_first>
    packages/agent-server/src/types.ts,
    relay/lib/room.js
  </read_first>
  <action>
    1. 创建 src/hands-router.ts。

    2. HandsRouter 类:
       - 内部维护 Map<handId, HandEntry>，HandEntry 包含 ws、id、capabilities、definitions、lastHeartbeat、priority（注册顺序自增）
       - register(entry: HandEntry): 添加到 map，记录 priority
       - unregister(handId: string): 从 map 移除
       - findHand(toolName: string): HandEntry | null — 遍历所有健康 Hand，找到 capabilities 包含 toolName 的，返回优先级最高的
       - getHandById(handId: string): HandEntry | undefined
       - getAllDefinitions(): ToolDefinition[] — 聚合所有健康 Hand 的 definitions，同名工具保留优先级最高的
       - getHandCount(): number
       - updateHeartbeat(handId: string): 更新 lastHeartbeat
       - checkHealth(timeoutMs = 30000): 检查所有 Hand 的 lastHeartbeat，超时的标记为不健康
       - isHealthy(entry: HandEntry): boolean — lastHeartbeat 在 timeoutMs 内

    3. 编写 hands-router.test.ts，使用 mock WebSocket 对象（不需要真实连接），覆盖所有 behavior。

    4. 更新 src/index.ts 导出 HandsRouter。
  </action>
  <verify>
    <automated>cd packages/agent-server && npx vitest run src/hands-router.test.ts</automated>
  </verify>
  <done>
    - HandsRouter 所有方法行为正确
    - 工具名路由到正确的 Hand
    - 同名工具冲突时先注册优先
    - 心跳超时 Hand 被排除
    - 测试全部通过
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: HandAwareToolExecutor — 路由工具调用到在线 Hand</name>
  <files>
    packages/agent-server/src/hand-aware-tool-executor.ts,
    packages/agent-server/src/hand-aware-tool-executor.test.ts,
    packages/agent-server/src/index.ts
  </files>
  <behavior>
    - getDefinitions() 返回 HandsRouter 聚合的所有工具定义
    - execute("FileRead", {path: "/a.ts"}, ctx) 找到注册 FileRead 的 Hand，发送 hand:execute，等待 hand:result
    - execute("不存在", ...) 返回 { output: "No hand available for tool: 不存在", isError: true }
    - Hand 超时（30s）未返回结果 → 返回 { output: "Tool execution timed out", isError: true }
    - Hand 在执行中断开连接 → 返回 { output: "Hand disconnected during execution", isError: true }
    - isReadOnly("FileRead") 返回 true，isReadOnly("FileWrite") 返回 false（从 Hand 注册的 definitions 中读取）
    - 未知工具 isReadOnly 返回 false（保守策略）
  </behavior>
  <read_first>
    packages/agent-server/src/hands-router.ts,
    packages/brain/src/interfaces.ts
  </read_first>
  <action>
    1. 创建 src/hand-aware-tool-executor.ts。

    2. HandAwareToolExecutor implements IToolExecutor:
       - 构造函数接收 HandsRouter 实例
       - 内部维护 pendingCalls: Map<callId, { resolve, timer }>，用于跟踪等待中的工具调用

    3. execute(name, input, context):
       - 调用 handsRouter.findHand(name) 查找 Hand
       - 如果没有 Hand → 返回错误结果
       - 生成 callId (crypto.randomUUID())
       - 创建 Promise，存储 resolve 到 pendingCalls
       - 通过 Hand 的 ws 发送 { event: "hand:execute", data: { callId, name, input, context: { workingDirectory, projectRoots } } }
       - 设置 30s 超时 timer
       - 如果 Hand 的 ws 在等待期间断开，清理并返回错误
       - resolve Promise 返回 { output, isError }

    4. handleResult(callId, output, isError):
       - 从 pendingCalls 取出 resolve，clearTimeout，调用 resolve({ output, isError })
       - 此方法由 server 层在收到 hand:result 消息时调用

    5. handleHandDisconnect(handId):
       - 清理该 Hand 所有 pendingCalls，返回超时错误

    6. getDefinitions():
       - 委托给 handsRouter.getAllDefinitions()

    7. isReadOnly(toolName):
       - 遍历所有 Hand 的 definitions，找到匹配的，返回其 isReadOnly 属性
       - 未找到返回 false

    8. 编写 hand-aware-tool-executor.test.ts:
       - 创建 mock HandsRouter（返回预设的 Hand）
       - 创建 mock WebSocket（记录发送的消息，模拟 hand:result 回复）
       - 测试所有 behavior 条目

    9. 更新 src/index.ts 导出 HandAwareToolExecutor。
  </action>
  <verify>
    <automated>cd packages/agent-server && npx vitest run src/hand-aware-tool-executor.test.ts</automated>
  </verify>
  <done>
    - HandAwareToolExecutor 完整实现 IToolExecutor 接口
    - 工具调用正确路由到在线 Hand
    - 超时和断连场景有 fallback 错误返回
    - isReadOnly 从 Hand 定义中读取
    - 所有测试通过
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Hand → HandsRouter | Hand 发送 hand:result，可能伪造成功/失败结果 |
| ToolExecutor → Hand | 工具输入可能包含路径遍历等恶意内容 |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02b-01 | S | hand:register | accept | Hand 连接已通过 Token 认证，注册内容可信 |
| T-02b-02 | D | HandAwareToolExecutor | mitigate | 30s 超时防止 Hand 无响应阻塞 agent |
| T-02b-03 | I | hand:result | accept | 单用户环境，Hand 伪造结果影响有限 |
</threat_model>

<verification>
```bash
cd packages/agent-server
npx tsc --noEmit
npx vitest run
```
</verification>

<success_criteria>
- HandsRouter 正确管理 Hand 注册、查找、移除
- HandAwareToolExecutor 实现完整 IToolExecutor 接口
- 工具调用路由到正确的 Hand，超时有 fallback
- 所有测试通过，TypeScript 编译无错误
</success_criteria>

<output>
After completion, create `.planning/phases/02-agent-server/02b-SUMMARY.md`
</output>
