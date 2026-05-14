---
phase: 03-hand-service
plan: 02
type: execute
wave: 2
depends_on: ["03a"]
files_modified:
  - packages/hand/src/tool-executor.ts
  - packages/hand/src/tool-executor.test.ts
  - packages/hand/src/index.ts
  - packages/hand/src/cli.ts
  - packages/hand/src/cli.test.ts
  - packages/hand/package.json
autonomous: true
requirements: [HAND-04, HAND-05, HAND-06]

must_haves:
  truths:
    - "Hand 收到 hand:execute 后能查找并执行本地工具"
    - "工具执行结果正确回传为 hand:result"
    - "npx wzxclaw-hand 启动 Hand 服务并连接到 Brain"
    - "Hand 注册的工具定义与实际执行能力一致"
  artifacts:
    - path: "packages/hand/src/tool-executor.ts"
      provides: "本地工具注册和执行框架"
      exports: ["LocalToolExecutor"]
    - path: "packages/hand/src/cli.ts"
      provides: "CLI 入口点，配置解析，启动 Hand 服务"
      exports: ["runCli"]
    - path: "packages/hand/src/index.ts"
      provides: "包 barrel exports"
    - path: "packages/hand/package.json"
      provides: "bin 字段注册 wzxclaw-hand 命令"
      contains: '"bin"'
  key_links:
    - from: "packages/hand/src/cli.ts"
      to: "packages/hand/src/connection.ts"
      via: "创建 HandConnection 并连接"
      pattern: "HandConnection"
    - from: "packages/hand/src/cli.ts"
      to: "packages/hand/src/tool-executor.ts"
      via: "注册工具定义和执行回调"
      pattern: "LocalToolExecutor"
    - from: "packages/hand/src/tool-executor.ts"
      to: "packages/hand/src/connection.ts"
      via: "onExecute 回调中执行工具并发送 result"
      pattern: "sendResult"
---

<objective>
工具执行框架 + CLI 入口点 — Hand 服务可用

Purpose: 实现本地工具注册和执行框架，使 Hand 能响应 hand:execute 请求；提供 CLI 入口使 `npx wzxclaw-hand` 可直接启动。
Output: 完整可运行的 Hand 服务，`npx wzxclaw-hand --server ws://localhost:8082 --token xxx` 连接 Brain。
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
@.planning/phases/03-hand-service/03a-SUMMARY.md

<!-- 来自 03a 的接口契约 -->
@packages/hand/src/types.ts
@packages/hand/src/protocol.ts
@packages/hand/src/connection.ts

<interfaces>
<!-- executor 需要的 03a 产出接口 -->

From packages/hand/src/types.ts (created by 03a):
```typescript
interface HandConfig {
  serverUrl: string
  authToken: string
  handId?: string
  heartbeatIntervalMs?: number
  reconnectBaseMs?: number
}
enum HandStatus { disconnected, connecting, registering, connected, reconnecting }
interface HandToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  isReadOnly?: boolean
}
```

From packages/hand/src/connection.ts (created by 03a):
```typescript
class HandConnection {
  constructor(config: HandConfig, callbacks: {
    onExecute?: (data: { callId: string; name: string; input: Record<string, unknown>; context: { workingDirectory: string; projectRoots: string[] } }) => void
    onDisconnect?: () => void
    onStatusChange?: (status: HandStatus) => void
  })
  connect(): void
  sendResult(callId: string, output: string, isError: boolean): void
  startHeartbeat(): void
  stopHeartbeat(): void
  disconnect(): void
  getStatus(): HandStatus
}
```

From packages/brain/src/interfaces.ts:
```typescript
interface IToolExecutionResult {
  output: string
  isError: boolean
}
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: LocalToolExecutor — 本地工具注册和执行框架</name>
  <files>packages/hand/src/tool-executor.ts, packages/hand/src/tool-executor.test.ts</files>
  <behavior>
    - register(tool) 注册一个工具到内部 registry
    - getDefinitions() 返回所有已注册工具的定义列表
    - getCapabilities() 返回所有已注册工具名列表
    - hasTool(name) 检查工具是否存在
    - execute(name, input, context) 查找并执行工具，返回 IToolExecutionResult
    - execute 工具不存在时返回 { output: "Tool not found: {name}", isError: true }
    - execute 工具抛异常时捕获并返回 { output: error.message, isError: true }
    - 工具接口：{ name, description, inputSchema, isReadOnly?, execute(input, context) => Promise<{output, isError}> }
  </behavior>
  <action>
    实现 LocalToolExecutor 类，管理本地工具的注册和执行。

    定义 HandTool 接口（简化版，不含 requiresApproval/requiresSnapshot 等 Brain 端概念）：
    ```typescript
    interface HandTool {
      readonly name: string
      readonly description: string
      readonly inputSchema: Record<string, unknown>
      readonly isReadOnly?: boolean
      execute(input: Record<string, unknown>, context: { workingDirectory: string; projectRoots: string[] }): Promise<{ output: string; isError: boolean }>
    }
    ```

    LocalToolExecutor 类：
    - 内部使用 Map<string, HandTool> 存储已注册工具
    - register(tool) 添加到 map，重复 name 覆盖
    - getDefinitions() 返回 map 中所有工具的 { name, description, inputSchema, isReadOnly } 数组
    - getCapabilities() 返回 map 中所有工具名数组
    - hasTool(name) 检查 name 是否在 map 中
    - execute(name, input, context) 实现：
      1. 从 map 查找工具，不存在返回 { output: `Tool not found: ${name}`, isError: true }
      2. 调用 tool.execute(input, context)，try-catch 包裹
      3. 正常返回工具结果
      4. 异常捕获：{ output: error.message, isError: true }
    - addBuiltinTools() 方法注册内置示例工具（EchoTool 用于测试：回显输入参数）

    tool-executor.test.ts 覆盖：
    - 注册和获取定义
    - getCapabilities 返回正确列表
    - hasTool 查找存在和不存在的工具
    - execute 正常工具
    - execute 不存在的工具返回错误
    - execute 工具抛异常时返回错误
    - 重复注册覆盖旧定义
    - EchoTool 内置工具正常工作
  </action>
  <verify>
    <automated>cd E:/ai/wzxClaw/packages/hand && npx vitest run src/tool-executor.test.ts</automated>
  </verify>
  <done>tool-executor.test.ts 全部通过，LocalToolExecutor 可注册/查找/执行工具</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: CLI 入口 + npx 支持 + barrel exports</name>
  <files>packages/hand/src/cli.ts, packages/hand/src/cli.test.ts, packages/hand/src/index.ts, packages/hand/package.json</files>
  <behavior>
    - runCli() 解析命令行参数：--server, --token, --id, --heartbeat
    - runCli() 支持 SERVER_URL 和 AUTH_TOKEN 环境变量
    - runCli() 创建 HandConnection + LocalToolExecutor，连接服务器
    - runCli() 注册工具到 executor，绑定 onExecute 回调
    - runCli() 处理 SIGINT/SIGTERM 信号优雅退出
    - 无必需参数时打印 usage 帮助信息并退出
    - package.json bin 字段注册 wzxclaw-hand 命令指向 dist/cli.js
  </behavior>
  <action>
    创建 CLI 入口点和包导出。

    packages/hand/src/cli.ts：
    - 解析 process.argv，提取 --server, --token, --id, --heartbeat 参数
    - 环境变量回退：SERVER_URL, AUTH_TOKEN, HAND_ID
    - 验证必需参数（server, token），缺少时打印 usage 并 process.exit(1)
    - usage 格式：
      ```
      Usage: wzxclaw-hand --server <url> --token <token> [--id <hand-id>] [--heartbeat <ms>]

      Options:
        --server    Agent server WebSocket URL (env: SERVER_URL)
        --token     Authentication token (env: AUTH_TOKEN)
        --id        Hand unique ID (auto-generated if not set)
        --heartbeat Heartbeat interval in ms (default: 15000)

      Environment variables:
        SERVER_URL   Agent server WebSocket URL
        AUTH_TOKEN   Authentication token
        HAND_ID      Hand unique ID
      ```
    - 创建 LocalToolExecutor，注册内置工具（EchoTool）
    - 创建 HandConnection，绑定 onExecute 回调：
      onExecute 中调用 executor.execute(name, input, context) 并将结果通过 connection.sendResult() 回传
    - 绑定 onStatusChange 回调，打印状态变更日志到 console.log
    - 绑定 onDisconnect 回调，打印断连日志
    - 注册 SIGINT/SIGTERM 处理器调用 connection.disconnect() + process.exit(0)
    - 调用 connection.connect()

    packages/hand/src/cli.test.ts：
    - 测试参数解析逻辑（可以提取 parseArgs 函数单独测试）
    - 测试缺少必需参数时打印 usage
    - 测试环境变量回退
    - 测试完整启动流程（使用 mock HandConnection factory）

    packages/hand/src/index.ts barrel exports：
    - 导出 HandConnection, LocalToolExecutor
    - 导出所有 types（HandConfig, HandStatus, HandToolDefinition, HandTool）
    - 导出 protocol 函数

    更新 packages/hand/package.json：
    - 添加 bin 字段：{ "wzxclaw-hand": "./dist/cli.js" }
    - 确保不依赖 @wzxclaw/brain（Hand 不需要 brain 包的运行时依赖）
    - cli.ts 入口使用 shebang：#!/usr/bin/env node（通过 build 脚本或手动确认 dist/cli.js 包含 shebang）
  </action>
  <verify>
    <automated>cd E:/ai/wzxClaw/packages/hand && npx vitest run</automated>
  </verify>
  <done>
    - cli.test.ts 全部通过
    - npx tsc --noEmit 无错误
    - package.json 包含 bin 字段注册 wzxclaw-hand
    - index.ts 导出所有公共 API
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| CLI args → Hand service | 用户输入的配置参数需要验证 |
| server → Hand execute | 服务器发送的工具执行请求，input 可能包含恶意内容 |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03b-01 | T | cli.ts parseArgs | mitigate | 验证 server URL 格式（必须以 ws:// 或 wss:// 开头），token 非空 |
| T-03b-02 | E | tool-executor.ts execute | mitigate | 工具执行异常统一捕获，不会导致进程崩溃 |
| T-03b-03 | D | cli.ts | accept | Hand 是本地运行的服务，拒绝服务只影响本机。CLI 参数验证足够 |
| T-03b-04 | I | cli.ts env vars | accept | 环境变量在受信任的本地环境读取，不涉及远程输入 |
</threat_model>

<verification>
cd E:/ai/wzxClaw/packages/hand && npx vitest run
cd E:/ai/wzxClaw/packages/hand && npx tsc --noEmit
</verification>

<success_criteria>
- packages/hand/src/tool-executor.ts 导出 LocalToolExecutor 类
- packages/hand/src/cli.ts 导出 runCli 函数
- packages/hand/src/index.ts 导出所有公共 API
- packages/hand/package.json 包含 bin 字段 { "wzxclaw-hand": "./dist/cli.js" }
- 所有测试通过，tsc 编译无错误
- `npx wzxclaw-hand --help` 可打印 usage 信息
- `npx wzxclaw-hand --server ws://localhost:8082 --token test` 可启动 Hand 并连接（需 agent-server 运行）
</success_criteria>

<output>
After completion, create `.planning/phases/03-hand-service/03b-SUMMARY.md`
</output>
