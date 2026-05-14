---
phase: 01-brain-hands-separation
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/brain/package.json
  - packages/brain/tsconfig.json
  - packages/brain/vitest.config.ts
  - packages/brain/src/index.ts
  - packages/brain/src/interfaces.ts
  - packages/brain/src/types.ts
  - packages/brain/src/agent/types.ts
  - packages/brain/src/agent/streaming-tool-executor.ts
  - packages/brain/src/agent/conversation-manager.ts
  - packages/brain/src/agent/message-builder.ts
  - packages/brain/src/agent/loop-detector.ts
  - packages/brain/src/agent/runtime-config.ts
  - packages/brain/src/llm/types.ts
autonomous: true
requirements: [INFRA-01, INFRA-02]

must_haves:
  truths:
    - "packages/brain/ 存在且 npm install 成功"
    - "packages/brain/ 的 tsc 编译无 Electron 依赖"
    - "核心接口 (IToolExecutor, IStreamProvider, ISessionStore, IEventSender) 在 interfaces.ts 中定义"
    - "AgentEvent 类型在 brain 包内独立可用"
  artifacts:
    - path: "packages/brain/package.json"
      provides: "npm 包配置，零 Electron 依赖"
    - path: "packages/brain/src/interfaces.ts"
      provides: "核心依赖注入接口"
      contains: "IToolExecutor"
    - path: "packages/brain/src/types.ts"
      provides: "共享类型定义（从 shared/ 复制，无 Electron 引用）"
      contains: "LLMProvider"
    - path: "packages/brain/src/agent/types.ts"
      provides: "AgentEvent 联合类型 + AgentConfig"
      contains: "AgentEvent"
  key_links:
    - from: "packages/brain/src/interfaces.ts"
      to: "packages/brain/src/types.ts"
      via: "import type references"
      pattern: "import.*from.*types"
---

<objective>
初始化 packages/brain/ 包脚手架，定义核心依赖注入接口，复制并编译纯逻辑模块（无 Electron 耦合）。

Purpose: 为后续解耦 AgentLoop/TurnManager 建立基础。这一步创建的接口契约是整个 Brain 提取的基石——后续所有 Electron 解耦工作都基于这些接口。
Output: packages/brain/ 包含 package.json、tsconfig.json、核心接口、纯逻辑模块（LLM types、ConversationManager、MessageBuilder、LoopDetector、StreamingToolExecutor、AgentEvent 类型）。
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md

@wzxClaw_desktop/src/shared/types.ts
@wzxClaw_desktop/src/main/agent/types.ts
@wzxClaw_desktop/src/main/agent/interfaces.ts
@wzxClaw_desktop/src/main/agent/streaming-tool-executor.ts
@wzxClaw_desktop/src/main/agent/conversation-manager.ts
@wzxClaw_desktop/src/main/agent/message-builder.ts
@wzxClaw_desktop/src/main/agent/loop-detector.ts
@wzxClaw_desktop/src/main/agent/runtime-config.ts
@wzxClaw_desktop/src/main/llm/types.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: 初始化包脚手架 + 核心类型 + 接口定义</name>
  <files>
    packages/brain/package.json,
    packages/brain/tsconfig.json,
    packages/brain/vitest.config.ts,
    packages/brain/src/index.ts,
    packages/brain/src/types.ts,
    packages/brain/src/interfaces.ts,
    packages/brain/src/agent/types.ts,
    packages/brain/src/agent/runtime-config.ts
  </files>
  <read_first>
    wzxClaw_desktop/package.json
    wzxClaw_desktop/tsconfig.json
    wzxClaw_desktop/vitest.config.ts
    wzxClaw_desktop/src/shared/types.ts
    wzxClaw_desktop/src/main/agent/types.ts
    wzxClaw_desktop/src/main/agent/interfaces.ts
    wzxClaw_desktop/src/main/agent/runtime-config.ts
  </read_first>
  <action>
1. 创建 `packages/brain/` 目录结构:
   ```
   packages/brain/
   ├── package.json
   ├── tsconfig.json
   ├── vitest.config.ts
   └── src/
       ├── index.ts          (barrel export)
       ├── types.ts          (从 shared/types.ts 复制必要类型)
       ├── interfaces.ts     (核心 DI 接口)
       └── agent/
           ├── types.ts      (从 agent/types.ts 复制)
           └── runtime-config.ts (从 agent/runtime-config.ts 复制)
   ```

2. `package.json`:
   - name: "@wzxclaw/brain"
   - version: "0.1.0"
   - type: "module"
   - main/main/module/exports 配置指向 dist/
   - scripts: build (tsc), test (vitest run), test:watch (vitest)
   - dependencies: 无运行时依赖（纯接口 + 类型）
   - devDependencies: typescript, vitest, @types/node (与桌面端版本一致)
   - license: "UNLICENSED" (个人工具)

3. `tsconfig.json`:
   - compilerOptions: target ES2022, module NodeNext, moduleResolution NodeNext, strict true, outDir dist, rootDir src
   - include: src

4. `vitest.config.ts`: 简单配置，test.include 为 src/**/*.test.ts

5. `src/types.ts` — 从 `wzxClaw_desktop/src/shared/types.ts` 复制以下类型（不复制 Electron 特有的如 FileTreeNode、ImageContent 等）:
   - LLMProvider type alias
   - TokenUsage interface
   - ContentBlock 联合类型 (TextContentBlock, ToolUseContentBlock, ThinkingContentBlock)
   - Message 联合类型 (UserMessage, AssistantMessage, ToolResultMessage)
   - ToolCall interface
   - ToolResult interface
   - ToolDefinition interface
   - StreamEvent 联合类型（全部 7 个子类型）
   - Workspace interface（AgentConfig 需要）
   - 去掉 z 导入，改为纯 TypeScript interface（Zod 是桌面端验证用的）

6. `src/interfaces.ts` — 定义核心依赖注入接口:
   ```typescript
   // IToolExecutor — 工具执行抽象（替代 TurnManager.createExecuteToolFn）
   export interface IToolExecutor {
     execute(name: string, input: Record<string, unknown>, context: IToolExecutionContext): Promise<IToolExecutionResult>
     getDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
     isReadOnly(toolName: string): boolean
   }

   // IToolExecutionContext — 工具执行上下文
   export interface IToolExecutionContext {
     workingDirectory: string
     projectRoots: string[]
     abortSignal: AbortSignal
     workspaceId?: string
     langfuseParentSpan?: unknown
     onSubAgentEvent?: (event: Record<string, unknown>) => void
   }

   // IToolExecutionResult — 工具执行结果
   export interface IToolExecutionResult {
     output: string
     isError: boolean
   }

   // IStreamProvider — LLM 流抽象（替代直接引用 LLMGateway）
   export interface IStreamProvider {
     stream(options: import('./agent/types').StreamOptions): AsyncGenerator<import('./types').StreamEvent>
   }

   // ISessionStore — 会话持久化抽象
   export interface ISessionStore {
     appendMessage(sessionId: string, message: unknown): Promise<void>
     loadSession(sessionId: string): Promise<unknown[]>
     listSessions(): Promise<Array<{ id: string; title: string; updatedAt: number }>>
     deleteSession(sessionId: string): Promise<void>
   }

   // IEventSender — 事件发送抽象（替代 Electron.WebContents）
   export interface IEventSender {
     send(channel: string, data: unknown): void
     isDestroyed?(): boolean
   }

   // IPermissionManager — 权限管理抽象
   export interface IPermissionManager {
     needsApproval(toolName: string, toolInput?: Record<string, unknown>): boolean
     requestApproval(conversationId: string, toolName: string, toolInput: Record<string, unknown>): Promise<boolean>
     getPlanModeRejection(toolName: string): string | null
   }

   // IContextManager — 上下文管理抽象
   export interface IContextManager {
     shouldCompact(messages: import('./types').Message[], modelId: string): boolean
     compact(messages: import('./types').Message[], gateway: IStreamProvider, model: string, provider: string, systemPrompt?: string): Promise<import('./context/types').CompactResult>
     reactiveCompact(messages: import('./types').Message[]): import('./types').Message[]
     estimateTokens(messages: import('./types').Message[], modelId?: string): number
     trackTokenUsage(inputTokens: number, outputTokens: number): void
     getContextWindowForModel(modelId: string): number
     getMicrocompactConfig(): { gapMinutes: number; keepRecent: number }
     getConfig(): import('./agent/runtime-config').AgentRuntimeConfig
   }

   // IToolExecutor 内部使用的内部接口
   export interface ILoopDetector {
     record(toolName: string, toolInput: Record<string, unknown>): void
     isLooping(): boolean
     reset(): void
   }

   // IHookRegistry — 钩子注册表抽象
   export interface IHookRegistry {
     emit(event: string, context: Record<string, unknown>): Promise<void>
   }

   // IObservability — 可观测性抽象（替代直接引用 langfuse-observer）
   export interface IObservability {
     startTrace(conversationId: string, model: string, userMessage: string, workingDir: string, parentSpan?: unknown): void
     endTrace(conversationId: string, usage: import('./types').TokenUsage, turnCount: number, error: boolean, messages?: import('./types').Message[]): void
     getActiveTrace(conversationId: string): ITraceContext | undefined
   }

   export interface ITraceContext {
     evalCollector: {
       recordToolCall(name: string, isError: boolean, isLoop: boolean): void
       recordTurn(outputTokens: number): void
       recordContextPressure(tokens: number, window: number): void
       recordErrorRecovery(type: string): void
       recordCompaction(): void
     }
     startGeneration(turnIndex: number, model: string, messages: unknown[]): IGenerationSpan
     startToolSpan(name: string, input: Record<string, unknown>): IToolSpan
   }

   export interface IGenerationSpan {
     update(data: Record<string, unknown>): void
     end(): void
   }

   export interface IToolSpan {
     update(data: Record<string, unknown>): void
     end(): void
   }
   ```

7. `src/agent/types.ts` — 从 `wzxClaw_desktop/src/main/agent/types.ts` 复制，改 import 路径:
   - AgentEvent 联合类型（全部 10 个子类型）
   - AgentConfig interface
   - import 类型从 `../../shared/types` 改为 `../types`

8. `src/agent/runtime-config.ts` — 从桌面端原样复制，改 import 路径（无外部依赖）

9. `src/index.ts` — barrel export 所有公共类型和接口

所有代码注释使用中文，与现有代码风格一致。
  </action>
  <verify>
    <automated>cd packages/brain && npm install && npx tsc --noEmit && echo "OK"</automated>
  </verify>
  <done>
    - packages/brain/ 存在，npm install 无错误
    - tsc --noEmit 编译通过，无 Electron 依赖
    - interfaces.ts 导出 IToolExecutor, IStreamProvider, ISessionStore, IEventSender, IPermissionManager, IContextManager, IObservability
    - types.ts 导出 Message, StreamEvent, LLMProvider, ToolCall, TokenUsage
    - agent/types.ts 导出 AgentEvent, AgentConfig
  </done>
</task>

<task type="auto">
  <name>Task 2: 复制纯逻辑模块（无 Electron 耦合）</name>
  <files>
    packages/brain/src/llm/types.ts,
    packages/brain/src/llm/retry.ts,
    packages/brain/src/agent/streaming-tool-executor.ts,
    packages/brain/src/agent/conversation-manager.ts,
    packages/brain/src/agent/message-builder.ts,
    packages/brain/src/agent/loop-detector.ts
  </files>
  <read_first>
    wzxClaw_desktop/src/main/llm/types.ts
    wzxClaw_desktop/src/main/llm/retry.ts
    wzxClaw_desktop/src/main/agent/streaming-tool-executor.ts
    wzxClaw_desktop/src/main/agent/conversation-manager.ts
    wzxClaw_desktop/src/main/agent/message-builder.ts
    wzxClaw_desktop/src/main/agent/loop-detector.ts
  </read_first>
  <action>
从桌面端复制以下纯逻辑模块到 packages/brain/，修改 import 路径：

1. `llm/types.ts` — 从 `wzxClaw_desktop/src/main/llm/types.ts` 复制
   - StreamOptions interface（去掉 RetryInfo 重导出，保留 RetryInfo import 和 onRetry 回调）
   - LLMAdapter interface
   - ProviderConfig interface
   - import 路径: `../../shared/types` -> `../types`
   - 同时复制 `llm/retry.ts`（PromptTooLongError 类和 RetryInfo interface），同样改 import

2. `agent/streaming-tool-executor.ts` — 从桌面端原样复制
   - 无外部 import，纯自包含模块
   - 包含 ToolExecResult interface 和 StreamingToolExecutor class

3. `agent/conversation-manager.ts` — 从桌面端原样复制
   - import Message, ContentBlock, ToolCall 从 `../../shared/types` 改为 `../types`

4. `agent/message-builder.ts` — 从桌面端复制
   - import Message, LLMProvider, ContentBlock 从 `../../shared/types` 改为 `../types`

5. `agent/loop-detector.ts` — 从桌面端原样复制
   - 无外部依赖，纯自包含

6. 更新 `src/index.ts` barrel export，导出所有新增模块的公共接口

注意：所有模块的代码逻辑保持不变，只改 import 路径。确保没有 `electron` 或 `../../shared` 的引用残留。
  </action>
  <verify>
    <automated>cd packages/brain && npx tsc --noEmit && echo "OK" && grep -rn "electron\|../../shared" src/ && echo "FAIL: has electron/shared refs" || echo "PASS: no electron/shared refs"</automated>
  </verify>
  <done>
    - tsc --noEmit 编译通过
    - 所有文件无 electron/../../shared 引用
    - ConversationManager, MessageBuilder, LoopDetector, StreamingToolExecutor, LLMAdapter 类型全部可用
    - llm/types.ts 导出 StreamOptions, LLMAdapter, ProviderConfig
  </done>
</task>

</tasks>

<verification>
cd packages/brain && npm install && npx tsc --noEmit
grep -rn "electron" packages/brain/src/ || echo "No Electron references"
</verification>

<success_criteria>
- packages/brain/ 包含完整的包配置和类型定义
- tsc 编译零错误
- 零 Electron 依赖
- 核心接口 IToolExecutor, IStreamProvider, ISessionStore, IEventSender 已定义
- 纯逻辑模块（ConversationManager, MessageBuilder, LoopDetector, StreamingToolExecutor, LLM types）已复制并可编译
</success_criteria>

<output>
After completion, create `.planning/phases/01-brain-hands-separation/01a-SUMMARY.md`
</output>
