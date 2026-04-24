# Tools -- Agent 的双手：定义、调度与执行

## 1. 概述

如果说 Model 是 Agent 的「大脑」，那么 Tools 就是 Agent 的「双手」。LLM 本身只能生成文本，但通过 Tool Use 机制，LLM 可以声明「我要调用 FileRead 工具，参数是 path=/src/main.ts」，由 Agent Runtime 负责实际执行并返回结果。

在 Claude Code / wzxClaw 架构中，工具系统包含四个核心环节：

1. **定义**：每个工具声明名称、描述、输入 Schema、是否需要审批
2. **注册**：启动时注册内建工具，运行时动态添加 MCP 工具
3. **调度**：LLM 返回 tool_use 块后，按并发安全性分配执行策略
4. **执行**：权限检查 → PreHook → 执行 → PostHook → 结果回传

---

## 2. Agent Loop 中的位置

```typescript
async function* agentLoop(userMessage, config) {
  const toolDefinitions = toolRegistry.getDefinitions()  // ← 工具定义

  for (let turn = 0; turn < maxTurns; turn++) {
    // 执行一轮 turn
    turnResult = yield* executeTurn({
      systemPrompt,
      messages,
      tools: toolDefinitions,    // ← 传给 LLM：「你可以调用这些工具」
    })
  }
}

// TurnManager.executeTurn() 内部
async function* executeTurn(input, gateway, executeTool, isReadOnly) {
  // Phase 1: LLM 流式返回
  for await (const event of streamFn(streamOpts)) {
    if (event.type === 'tool_use_end') {
      // ★ 工具调用完整到达，立即启动执行 ★
      executor.onToolUseEnd(event.id, event.name, () => executeTool(toolCall))
    }
  }

  // Phase 2: 等待所有工具执行完成
  for (const pending of executor.getPending()) {
    const result = await pending.promise
    yield { type: 'agent:tool_result', ...result }
  }

  // Phase 3: 将工具结果追加到 messages，下一轮 LLM 可以看到
  conversation.appendToolResult(result.toolCallId, result.output, result.isError)
}
```

关键时序：LLM 流式输出 → tool_use 块逐个到达 → **立即**启动工具执行 → 不等所有 tool_use 块完成。

---

## 3. Tool 接口定义

```typescript
interface Tool {
  /** 工具唯一名称，LLM 通过这个名字调用 */
  readonly name: string
  /** 工具描述，LLM 根据描述决定何时使用 */
  readonly description: string
  /** JSON Schema 定义输入参数 */
  readonly inputSchema: Record<string, unknown>
  /** 是否需要用户审批（写入/执行类工具为 true） */
  readonly requiresApproval: boolean
  /** 是否只读（只读工具可并行执行） */
  readonly isReadOnly?: boolean

  /** 执行工具 */
  execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult>
}

interface ToolExecutionContext {
  workingDirectory: string
  taskId?: string
  abortSignal?: AbortSignal
  onProgress?: (message: string) => void
}

interface ToolExecutionResult {
  output: string | ToolResultContent[]
  isError: boolean
}
```

### 3.1 工具分类

| 类别 | 工具 | requiresApproval | isReadOnly | 并发性 |
|------|------|-----------------|------------|--------|
| 文件读取 | FileRead | false | true | 可并行 |
| 搜索 | Grep, Glob, SemanticSearch | false | true | 可并行 |
| Web | WebSearch, WebFetch | false | true | 可并行 |
| 符号导航 | GoToDefinition, FindReferences, SearchSymbols | false | true | 可并行 |
| 步骤管理 | CreateStep, UpdateStep | false | true | 可并行 |
| 任务管理 | TodoWrite | false | true | 可并行 |
| 文件写入 | FileWrite, FileEdit | true | false | 串行 |
| 命令执行 | Bash | true | false | 串行 |

### 3.2 工具定义传给 LLM 的格式

```typescript
// Anthropic API 格式
{
  name: "FileRead",
  description: "Read a file from the local filesystem...",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path" },
      offset: { type: "number", description: "Line number to start from" },
      limit: { type: "number", description: "Number of lines to read" }
    },
    required: ["path"]
  }
}

// OpenAI API 格式（SDK 自动转换）
{
  type: "function",
  function: {
    name: "FileRead",
    description: "Read a file from the local filesystem...",
    parameters: { /* 同上 input_schema */ }
  }
}
```

---

## 4. 工具注册与发现

### 4.1 静态注册（启动时）

```typescript
function createDefaultTools(workingDir, terminalManager, getWebContents, stepManager, indexingEngine) {
  const registry = new ToolRegistry()

  // 只读工具（无需审批）
  registry.register(new FileReadTool())
  registry.register(new GrepTool())
  registry.register(new GlobTool())
  registry.register(new SemanticSearchTool())
  registry.register(new WebSearchTool())
  registry.register(new WebFetchTool())

  // 符号导航工具（需要 Monaco IPC）
  registry.register(new GoToDefinitionTool(getWebContents))
  registry.register(new FindReferencesTool(getWebContents))
  registry.register(new SearchSymbolsTool(getWebContents))

  // 写入工具（需要审批）
  registry.register(new FileWriteTool())
  registry.register(new FileEditTool())
  registry.register(new BashTool(workingDir, terminalManager))

  return registry
}
```

### 4.2 动态注册（运行时 MCP）

```
启动流程:
  1. 读取 ~/.wzxclaw/mcp.json
  2. 对每个 MCP server:
     a. 建立连接 (stdio/SSE)
     b. 调用 tools/list 获取工具列表
     c. 为每个工具创建 McpToolWrapper
     d. registry.register(wrapper)   ← 动态添加

MCP 工具命名规则: mcp_{serverName}_{toolName}
  例: mcp_github_create_issue
      mcp_filesystem_read_file
```

### 4.3 ToolRegistry 核心接口

```typescript
class ToolRegistry {
  private tools: Map<string, Tool> = new Map()

  register(tool: Tool): void           // 注册一个工具
  get(name: string): Tool | undefined  // 按名称查找
  getAll(): Tool[]                     // 获取所有工具
  getDefinitions(): ToolDefinition[]   // 获取 LLM 格式的定义
  getApprovalRequired(): string[]      // 获取需要审批的工具列表
  isReadOnly(toolName: string): bool   // 判断是否只读
}
```

---

## 5. 调度策略 -- StreamingToolExecutor

### 5.1 核心设计

LLM 流式返回多个 tool_use 块时，不等所有块到达，**每个块到达后立即启动执行**：

```typescript
class StreamingToolExecutor {
  private pending: Array<{ id, name, promise }> = []
  private writeChain: Promise = Promise.resolve()  // 串行链

  onToolUseEnd(id, name, execute) {
    if (this.isReadOnly(name)) {
      // 只读工具：立即并行启动
      const promise = execute()
      this.pending.push({ id, name, promise })
    } else {
      // 写入工具：链接到串行链
      const promise = this.writeChain.then(() => execute())
      this.writeChain = promise.catch(() => {})  // 吸收错误，不阻塞后续
      this.pending.push({ id, name, promise })
    }
  }
}
```

### 5.2 调度时序图

```
LLM 流式输出:
  ──[text_delta]──[text_delta]──[tool_use: Grep]──[tool_use: Glob]──[tool_use: FileEdit]──[tool_use: Grep]──[done]

工具执行:
  [Grep #1] ──────并行启动───────────── 结果 ✓
  [Glob #2]  ──────并行启动───────────── 结果 ✓
  [Grep #4]   ────────────并行启动─────── 结果 ✓
  [FileEdit #3] ──────────────等待 Grep/Glob─────────────串行执行───── 结果 ✓

时间轴: ──────────────────────────────────────────────────────→
```

注意 `FileEdit #3` 虽然在 `Grep #4` 之前到达，但因为它是写入工具，必须串行执行。而 `Grep #4` 是只读工具，可以和 `FileEdit #3` 并行（但不影响 `FileEdit` 的串行顺序）。

### 5.3 结果收集

```typescript
// 按原始 LLM 发射顺序（插入顺序）收集结果
for (const pending of executor.getPending()) {
  const result = await pending.promise  // 只读工具可能已 resolve
  yield { type: 'agent:tool_result', ...result }
}
```

---

## 6. 工具执行完整生命周期

### 6.1 executeTool 函数

由 `TurnManager.createExecuteToolFn()` 创建的闭包，封装了完整的工具执行管线：

```typescript
async function executeTool(toolCall: ToolCall): Promise<ToolExecResult> {
  // 1. ★ 循环检测
  loopDetector.record(toolCall.name, toolCall.input)
  if (loopDetector.isLooping()) {
    return { ..., loopDetected: true }  // 同一调用重复 3+ 次
  }

  // 2. ★ 工具查找
  const tool = toolRegistry.get(toolCall.name)
  if (!tool) {
    return { ..., output: "Tool not found: ...", isError: true }
  }

  // 3. ★ Plan Mode 检查
  const rejection = permissionManager.getPlanModeRejection(toolCall.name)
  if (rejection) {
    return { ..., output: rejection, isError: true }
  }

  // 4. ★ 权限审批
  if (permissionManager.needsApproval(toolCall.name, toolCall.input)) {
    const approved = await permissionManager.requestApproval(...)
    if (!approved) {
      await hookRegistry?.emit('permission-denied', { ... })
      return { ..., output: "Permission denied", isError: true }
    }
  }

  // 5. ★ Pre-Tool Hook
  await hookRegistry?.emit('pre-tool', { toolName, toolInput, conversationId })

  // 5.5. 文件快照（写入前）
  if (toolCall.name === 'FileWrite' || toolCall.name === 'FileEdit') {
    await historyManager.snapshot(absolutePath, toolCall.id)
  }

  // 6. ★ 执行工具
  const result = await tool.execute(toolCall.input, {
    workingDirectory: config.workingDirectory,
    taskId,
    abortSignal,
  })

  // 7. ★ 输出截断
  const flatOutput = flattenToolOutput(result.output)
  const truncatedOutput = truncateToolResult(toolCall.name, flatOutput)

  // 8. ★ Post-Tool Hook
  await hookRegistry?.emit('post-tool', { toolName, toolInput, toolOutput, isError })

  // 9. 返回结果
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    output: flatOutput,           // 完整输出（UI 显示）
    truncatedOutput,              // 截断输出（喂回 LLM）
    isError: result.isError,
    loopDetected: false,
  }
}
```

### 6.2 生命周期时序图

```
LLM 返回 tool_use
    │
    ├── LoopDetector.record() ──── 检测重复调用
    │       └── isLooping? ──── YES → return loopDetected
    │
    ├── ToolRegistry.get() ────── 查找工具实例
    │       └── not found? ──→ return error
    │
    ├── PermissionManager ─────── Plan Mode 检查
    │       └── rejected? ────→ return error
    │
    ├── PermissionManager ─────── needsApproval?
    │       └── requestApproval() ── 用户审批弹窗
    │           └── denied? ──→ emit('permission-denied') → return error
    │
    ├── HookRegistry.emit('pre-tool') ──── Pre-Tool Hook
    │
    ├── HistoryManager.snapshot() ──── 文件快照（仅写入工具）
    │
    ├── tool.execute(input, ctx) ──── ★ 实际执行 ★
    │
    ├── truncateToolResult() ──── 截断过长输出
    │
    ├── HookRegistry.emit('post-tool') ──── Post-Tool Hook
    │
    └── return ToolExecResult ──── 结果回传
            │
            ├── output → UI 显示
            └── truncatedOutput → 追加到 messages（喂回 LLM）
```

---

## 7. 权限检查 -- 四种模式

```typescript
enum PermissionMode {
  'always-ask',    // 所有工具都需要审批
  'accept-edits',  // 文件编辑自动通过，命令执行需要审批
  'plan',          // 只允许只读工具，写入工具被拒绝
  'bypass',        // 全部自动通过（危险，用于 CI/CD）
}
```

### 权限决策流程

```
toolCall 到达
│
├── tool.requiresApproval === false
│   └── 直接执行（FileRead, Grep, Glob 等）
│
├── permissionMode === 'bypass'
│   └── 直接执行
│
├── permissionMode === 'plan'
│   └── getPlanModeRejection() → "Plan mode: destructive tools disabled"
│
├── permissionMode === 'accept-edits'
│   ├── FileWrite / FileEdit → 自动通过
│   └── Bash → 弹窗审批
│
└── permissionMode === 'always-ask'
    └── 所有写入工具 → 弹窗审批
```

### 审批弹窗交互

```
IPC 请求:
  renderer ← main: permission:request { toolName, toolInput, conversationId }
  renderer → main: permission:response { approved: true/false }

如果用户拒绝:
  → emit('permission-denied', { toolName, toolInput })
  → 返回 ToolExecResult { isError: true, output: "Permission denied" }
  → LLM 收到错误结果，可以调整策略
```

---

## 8. 生命周期钩子 (Hooks)

### 8.1 Hook 事件类型

| 事件 | 触发时机 | 用途 |
|------|---------|------|
| `session-start` | Agent Loop 开始 | 初始化日志、通知 |
| `session-end` | Agent Loop 结束 | 清理、报告 |
| `pre-tool` | 工具执行前 | 拦截、修改参数、记录 |
| `post-tool` | 工具执行后 | 审计、通知、后处理 |
| `permission-denied` | 用户拒绝审批 | 日志、降级策略 |
| `pre-compact` | 上下文压缩前 | 自定义压缩策略 |
| `post-compact` | 上下文压缩后 | 验证、通知 |

### 8.2 Hook 配置

```json
// ~/.wzxclaw/settings.json
{
  "hooks": {
    "pre-tool": [
      { "command": "echo 'Tool: ${toolName}' >> ~/.wzxclaw/audit.log" }
    ],
    "post-tool": [
      {
        "matcher": "FileWrite|FileEdit",
        "command": "npx prettier --write ${toolInput.path}"
      }
    ]
  }
}
```

### 8.3 Hook 执行流程

```
HookRegistry.emit('pre-tool', payload)
│
├── 查找匹配的 hook 配置
│   ├── 全局 hooks（无 matcher）→ 始终执行
│   └── 带 matcher 的 hooks → 正则匹配 toolName
│
├── 按顺序执行 command
│   ├── 替换变量: ${toolName}, ${toolInput}, ${conversationId}
│   ├── 子进程执行，超时 30 秒
│   └── 非零退出码 → 阻止工具执行
│
└── 继续 / 阻止
```

---

## 9. 结果回传与上下文管理

### 9.1 工具结果格式

```typescript
// 追加到 messages 的格式（Anthropic）
{
  role: "user",
  content: [{
    type: "tool_result",
    tool_use_id: "toolu_abc123",
    content: "File content here..."  // 截断后的输出
  }]
}

// 追加到 messages 的格式（OpenAI）
{
  role: "tool",
  tool_call_id: "call_abc123",
  content: "File content here..."  // 截断后的输出
}
```

### 9.2 输出截断策略

```typescript
function truncateToolResult(toolName: string, output: string): string {
  const MAX_LENGTH = 25000  // 字符数
  const TOOL_SPECIFIC = {
    'Bash': 30000,
    'FileRead': 50000,
    'Grep': 30000,
  }

  const limit = TOOL_SPECIFIC[toolName] ?? MAX_LENGTH
  if (output.length <= limit) return output

  return output.slice(0, limit) + '\n... [output truncated]'
}
```

### 9.3 全局工具结果预算

即使单个工具输出在限制内，所有工具结果的总和可能超出 context window：

```typescript
// enforceContextBudget() 在每轮 turn 结束后调用
function enforceContextBudget(entries: ToolResultEntry[]): ToolResultEntry[] {
  const TOTAL_BUDGET = 100000  // 字符数
  let remaining = TOTAL_BUDGET

  // 从最新到最旧分配预算
  for (const entry of reversed(entries)) {
    if (entry.result.length <= remaining) {
      remaining -= entry.result.length
    } else {
      entry.result = entry.result.slice(0, remaining) + '\n... [budget truncated]'
      remaining = 0
    }
  }
}
```

---

## 10. 总结

| 环节 | 关键机制 | 核心文件 |
|------|---------|---------|
| 定义 | `Tool` 接口 + JSON Schema | `tool-interface.ts` |
| 注册 | `ToolRegistry` Map + 静态/动态 | `tool-registry.ts` |
| 调度 | `StreamingToolExecutor` 并行/串行 | `streaming-tool-executor.ts` |
| 执行 | `TurnManager.createExecuteToolFn()` 闭包 | `turn-manager.ts` |
| 权限 | 四种模式 + IPC 审批弹窗 | `permission-manager.ts` |
| 钩子 | `HookRegistry.emit()` 事件系统 | `hook-registry.ts` |
| 截断 | 单工具限制 + 全局预算 | `tool-result-budget.ts` |
| 历史 | `FileHistoryManager.snapshot()` | `file-history-manager.ts` |
