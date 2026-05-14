---
phase: 01-brain-hands-separation
plan: 03
type: execute
wave: 3
depends_on: ["01-brain-hands-separation-01", "01-brain-hands-separation-02"]
files_modified:
  - packages/brain/src/agent/agent-loop.ts
  - packages/brain/src/agent/turn-manager.ts
  - packages/brain/src/agent/stream-phase.ts
  - packages/brain/src/agent/system-prompt-builder.ts
  - packages/brain/src/agent/agent-factory.ts
  - packages/brain/src/index.ts
autonomous: true
requirements: [INFRA-05, INFRA-06, INFRA-07]

must_haves:
  truths:
    - "AgentLoop.run() 返回 AsyncGenerator<AgentEvent>，不接收 Electron.WebContents"
    - "TurnManager 不包含 createExecuteToolFn()，改为接收外部注入的 ExecuteToolFn"
    - "所有 sender.send() 调用通过 IEventSender 接口"
    - "所有 IPC_CHANNELS 引用替换为字符串常量或通过 IEventSender 发送"
    - "system-prompt-builder 在 brain 包内可用"
  artifacts:
    - path: "packages/brain/src/agent/agent-loop.ts"
      provides: "解耦后的 AgentLoop"
      exports: ["AgentLoop"]
    - path: "packages/brain/src/agent/turn-manager.ts"
      provides: "解耦后的 TurnManager"
      exports: ["TurnManager"]
    - path: "packages/brain/src/agent/stream-phase.ts"
      provides: "流阶段逻辑（已无 Electron 依赖）"
      exports: ["executeStreamPhase", "StreamPhaseMeta", "ExecuteToolFn", "StreamFn"]
    - path: "packages/brain/src/agent/agent-factory.ts"
      provides: "AgentLoop 工厂函数（注入所有依赖）"
      exports: ["createAgentLoop"]
  key_links:
    - from: "packages/brain/src/agent/agent-loop.ts"
      to: "packages/brain/src/interfaces.ts"
      via: "import IEventSender, IObservability, IHookRegistry"
      pattern: "import.*from.*interfaces"
    - from: "packages/brain/src/agent/turn-manager.ts"
      to: "packages/brain/src/interfaces.ts"
      via: "import IToolExecutor 或接收 ExecuteToolFn"
      pattern: "ExecuteToolFn"
---

<objective>
核心解耦：重写 AgentLoop 和 TurnManager，移除所有 Electron 依赖（WebContents、IPC_CHANNELS、sender.send()），改用依赖注入接口。

Purpose: 这是整个 Phase 1 的核心。AgentLoop 和 TurnManager 是耦合最深的两个模块——它们直接引用 Electron.WebContents、IPC_CHANNELS、Langfuse observer。通过接口替换这些依赖，使 Brain 包完全脱离 Electron。
Output: AgentLoop + TurnManager + StreamPhase 在 brain 包内可用，零 Electron 依赖。
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md

<!-- 依赖 Plan 01 + 02 的产出 -->
@packages/brain/src/interfaces.ts
@packages/brain/src/types.ts
@packages/brain/src/constants.ts
@packages/brain/src/agent/types.ts
@packages/brain/src/agent/conversation-manager.ts
@packages/brain/src/agent/streaming-tool-executor.ts
@packages/brain/src/agent/message-builder.ts
@packages/brain/src/agent/loop-detector.ts
@packages/brain/src/agent/runtime-config.ts
@packages/brain/src/llm/types.ts
@packages/brain/src/llm/gateway.ts
@packages/brain/src/context/context-manager.ts
@packages/brain/src/context/types.ts

<!-- 源文件 -->
@wzxClaw_desktop/src/main/agent/agent-loop.ts
@wzxClaw_desktop/src/main/agent/turn-manager.ts
@wzxClaw_desktop/src/main/agent/stream-phase.ts
@wzxClaw_desktop/src/main/agent/system-prompt-builder.ts
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: 解耦 AgentLoop — 移除 Electron 依赖</name>
  <files>
    packages/brain/src/agent/agent-loop.ts,
    packages/brain/src/agent/agent-factory.ts,
    packages/brain/src/agent/__tests__/agent-loop.test.ts
  </files>
  <read_first>
    wzxClaw_desktop/src/main/agent/agent-loop.ts
    wzxClaw_desktop/src/main/agent/turn-manager.ts
    packages/brain/src/interfaces.ts
    packages/brain/src/agent/types.ts
    packages/brain/src/agent/conversation-manager.ts
    packages/brain/src/constants.ts
  </read_first>
  <behavior>
    - Test 1: AgentLoop.run() 返回 AsyncGenerator<AgentEvent>，yield agent:text + agent:done
    - Test 2: AgentLoop.run() 不接收 Electron.WebContents（编译时验证）
    - Test 3: AgentLoop 构造函数接受 IStreamProvider 而非 LLMGateway
    - Test 4: 安全天花板触发时 yield agent:error + agent:done
    - Test 5: cancel() 中止后 run() 自然退出
    - Test 6: IEventSender.send() 被正确调用（替代 sender.send()）
  </behavior>
  <action>
从 `wzxClaw_desktop/src/main/agent/agent-loop.ts` 复制并重构 AgentLoop 类：

1. **构造函数重写** — 改为接受接口注入:
   ```typescript
   constructor(
     private gateway: IStreamProvider,        // 替代 LLMGateway
     private contextManager: IContextManager,  // 替代 ContextManager 类
     private observability: IObservability,    // 替代 langfuse-observer 直接调用
     private hookRegistry?: IHookRegistry,     // 替代 HookRegistry 类
   ) {}
   ```
   - 移除 toolRegistry、permissionManager、historyManager 参数
   - 这些职责在 AgentLoop 外部通过 ExecuteToolFn 注入到 TurnManager

2. **run() 签名重写** — 移除 Electron.WebContents:
   ```typescript
   async *run(
     userMessage: string,
     config: AgentConfig,
     sender?: IEventSender,     // 替代 Electron.WebContents
     toolExecutor?: IToolExecutor,  // 新增：工具执行器
   ): AsyncGenerator<AgentEvent>
   ```

3. **消除 IPC_CHANNELS 引用** — 替换 sender.send(IPC_CHANNELS[...]) 为 sender.send(channel, data):
   - 保留 IPC channel 名称字符串（作为常量或直接字符串），但不 import IPC_CHANNELS
   - 创建 `src/channels.ts` 文件，定义 brain 包用到的 event channel 名称常量:
     ```typescript
     export const BRAIN_CHANNELS = {
       TODO_UPDATED: 'todo:updated',
       SESSION_COMPACTED: 'session:compacted',
       SUB_TOOL_USE_START: 'stream:sub_tool_use_start',
       SUB_TOOL_USE_END: 'stream:sub_tool_use_end',
       SUB_TEXT: 'stream:sub_text',
     } as const
     ```

4. **消除 Langfuse 直接调用**:
   - `startTrace()` -> `this.observability.startTrace()`
   - `endTrace()` -> `this.observability.endTrace()`
   - `getActiveTrace()` -> `this.observability.getActiveTrace()`
   - 如果 observability 为 null/undefined，跳过调用（可选依赖）

5. **消除 TodoWriteTool 直接依赖**:
   - AgentLoop 不再直接 import TodoWriteTool
   - Todo 恢复逻辑通过 IToolExecutor 或 IHookRegistry 的 session-start hook 处理
   - 如果无法通过现有接口处理，添加可选的 ITodoProvider 接口到 interfaces.ts

6. **消除 DebugLogger 依赖**:
   - DebugLogger 使用 Electron 路径（`~/.wzxclaw/debug/`）
   - 替换为接口 `ILogger`:
     ```typescript
     interface ILogger {
       log(level: string, message: string, data?: Record<string, unknown>): void
       close(): void
     }
     ```
   - AgentLoop 构造函数添加可选 `logger?: ILogger` 参数
   - 默认提供 no-op logger

7. **消除 ToolResultReplacementState / tool-result-storage 直接引用**:
   - ToolResultReplacementState 引用文件系统路径（`~/.wzxclaw/tool-results/`）
   - TurnManager 的 createExecuteToolFn 已在 Plan 01 中决定移除
   - 替代方案：executeTool 函数由外部注入，文件系统操作不进入 brain 包

8. **消除 system-prompt-builder 中的 Electron 依赖**:
   - buildSystemPrompt() 引用 git-context.ts（子进程调用 git）、instruction-loader.ts（文件系统）、env-info.ts（Node.js 环境）、MemoryManager（文件系统）
   - 在 brain 包中，system-prompt-builder 简化为：
     - 接收完整的 systemPrompt 字符串（已由外部构建）
     - 或提供一个 ISimplePromptBuilder 接口只做 static + CACHE_BOUNDARY + dynamic 拼接
   - 实际方案：创建简化版 `system-prompt-builder.ts`，只处理 cache boundary 拼接逻辑
   - 完整的 env/git/instruction/memory 组装留在桌面端

9. **创建 agent-factory.ts** — 提供 `createAgentLoop()` 工厂函数:
   ```typescript
   export function createAgentLoop(deps: {
     gateway: IStreamProvider
     contextManager: IContextManager
     observability?: IObservability
     hookRegistry?: IHookRegistry
     logger?: ILogger
   }): AgentLoop
   ```

10. 编写测试文件 `__tests__/agent-loop.test.ts`，使用 mock 接口验证:
    - 参考桌面端 `wzxClaw_desktop/src/main/agent/__tests__/agent-loop.test.ts` 的 mock 模式
    - Mock IStreamProvider, IContextManager, IObservability, IEventSender
    - 验证 run() 的基本流程和事件输出
  </action>
  <verify>
    <automated>cd packages/brain && npx tsc --noEmit && npx vitest run src/agent/__tests__/agent-loop.test.ts && echo "OK"</automated>
  </verify>
  <done>
    - AgentLoop 构造函数接受接口注入（IStreamProvider, IContextManager, IObservability, IHookRegistry）
    - run() 签名接受 IEventSender 而非 Electron.WebContents
    - 无 IPC_CHANNELS import
    - 无 Langfuse 直接调用
    - 无 DebugLogger 直接依赖
    - 测试通过
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: 解耦 TurnManager + StreamPhase — 接收外部 ExecuteToolFn</name>
  <files>
    packages/brain/src/agent/turn-manager.ts,
    packages/brain/src/agent/stream-phase.ts,
    packages/brain/src/agent/__tests__/turn-manager.test.ts
  </files>
  <read_first>
    wzxClaw_desktop/src/main/agent/turn-manager.ts
    wzxClaw_desktop/src/main/agent/stream-phase.ts
    packages/brain/src/interfaces.ts
    packages/brain/src/agent/agent-loop.ts
  </read_first>
  <behavior>
    - Test 1: TurnManager.executeTurn() 接收 ExecuteToolFn 而非内部创建
    - Test 2: TurnInput 不包含 Electron.WebContents（编译时验证）
    - Test 3: executeTurn yield agent:text + agent:tool_call + agent:tool_result + agent:turn_end
    - Test 4: StreamPhase 无 Electron 依赖（已无，但需验证）
    - Test 5: TurnManager 不再包含 createExecuteToolFn 方法
  </behavior>
  <action>
从桌面端复制并重构 TurnManager 和 StreamPhase：

1. **TurnManager 重构**:
   - 移除 `createExecuteToolFn()` 方法 — 这是主要的 Electron 耦合点（包含 sender: Electron.WebContents、permissionManager、contextManager、hookRegistry、historyManager）
   - `executeTurn()` 签名改为只接收纯数据参数 + 注入函数:
     ```typescript
     async *executeTurn(
       input: TurnInput,           // 纯数据
       streamFn: StreamFn,         // LLM 流函数（来自 gateway）
       executeTool: ExecuteToolFn, // 外部注入的工具执行函数
       isReadOnly: (toolName: string) => boolean,
       observability?: IObservability, // 可观测性接口
     ): AsyncGenerator<AgentEvent, TurnResult>
     ```
   - TurnInput 移除 `sender?: Electron.WebContents` 字段
   - TurnInput 改为纯数据接口（不含 Electron 类型）
   - 工具结果持久化（maybePersistLargeToolResult）保留但路径通过参数注入

2. **消除 TurnManager 中的 IPC_CHANNELS 引用**:
   - 移除 `import { IPC_CHANNELS } from '../../shared/ipc-channels'`
   - sender.send() 调用不再出现（已通过外部 executeTool 函数处理）

3. **消除 Langfuse 引用**:
   - `getActiveTrace()` 调用改为通过参数传入的 `observability.getActiveTrace()`
   - 或通过 TurnInput 传入 trace 上下文

4. **StreamPhase 验证**:
   - StreamPhase 已经是纯逻辑（无 Electron 依赖）
   - 只需改 import 路径
   - 验证无遗漏的 Electron 引用

5. **简化版 system-prompt-builder.ts**:
   - 只保留 cache boundary 拼接逻辑
   - 完整的 env/git/instruction/memory 组装由桌面端在调用 brain 之前完成
   - Brain 包的 system-prompt-builder 只做:
     ```typescript
     export function buildBrainSystemPrompt(
       staticPrompt: string,
       dynamicParts: string[],
     ): string
     ```

6. 编写测试:
   - Mock ExecuteToolFn、StreamFn
   - 验证 executeTurn 的 yield 事件序列
   - 验证无 Electron 类型残留
  </action>
  <verify>
    <automated>cd packages/brain && npx tsc --noEmit && npx vitest run src/agent/__tests__/turn-manager.test.ts && echo "OK" && grep -rn "createExecuteToolFn\|Electron\|WebContents\|IPC_CHANNELS" src/agent/turn-manager.ts src/agent/stream-phase.ts && echo "FAIL" || echo "PASS: no Electron refs"</automated>
  </verify>
  <done>
    - TurnManager 无 createExecuteToolFn 方法
    - TurnInput 无 Electron.WebContents 字段
    - executeTurn 接收外部注入的 ExecuteToolFn
    - StreamPhase 无 Electron 依赖
    - 无 IPC_CHANNELS 引用
    - 测试通过
  </done>
</task>

</tasks>

<verification>
cd packages/brain && npx tsc --noEmit
cd packages/brain && npx vitest run
grep -rn "electron\|WebContents\|ipcMain\|IPC_CHANNELS\|createExecuteToolFn" packages/brain/src/ || echo "No Electron references"
</verification>

<success_criteria>
- AgentLoop.run() 返回 AsyncGenerator<AgentEvent>，不接收 Electron.WebContents
- TurnManager 无 createExecuteToolFn()，接收外部 ExecuteToolFn
- 所有 sender.send() 通过 IEventSender 接口
- 全部测试通过
- 零 Electron 依赖
</success_criteria>

<output>
After completion, create `.planning/phases/01-brain-hands-separation/01c-SUMMARY.md`
</output>
