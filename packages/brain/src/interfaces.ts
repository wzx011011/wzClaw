// ============================================================
// 核心依赖注入接口
// 所有依赖通过接口类型注入，便于测试 mock 和未来替换实现
// 零 Electron 依赖
// ============================================================

import type { StreamEvent, Message, TokenUsage } from './types.js'
import type { CompactResult } from './types.js'
import type { AgentRuntimeConfig } from './agent/runtime-config.js'

// ---- 工具执行 ----

/** 工具执行上下文 */
export interface IToolExecutionContext {
  workingDirectory: string
  projectRoots: string[]
  abortSignal: AbortSignal
  workspaceId?: string
  langfuseParentSpan?: unknown
  onSubAgentEvent?: (event: Record<string, unknown>) => void
}

/** 工具执行结果 */
export interface IToolExecutionResult {
  output: string
  isError: boolean
}

/** 工具执行抽象（替代 TurnManager.createExecuteToolFn） */
export interface IToolExecutor {
  execute(name: string, input: Record<string, unknown>, context: IToolExecutionContext): Promise<IToolExecutionResult>
  getDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  isReadOnly(toolName: string): boolean
}

// ---- LLM 流 ----

/** LLM 流选项（完整定义见 llm/types.ts StreamOptions） */
export interface IStreamOptions {
  model: string
  messages: Array<{ role: string; content: unknown }>
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  tools?: Array<{
    name: string
    description: string
    input_schema: Record<string, unknown>
  }>
  abortSignal?: AbortSignal
  timeoutMs?: number
  fallbackModel?: string
  thinkingDepth?: 'none' | 'low' | 'medium' | 'high'
}

/** LLM 流抽象（替代直接引用 LLMGateway） */
export interface IStreamProvider {
  stream(options: IStreamOptions): AsyncGenerator<StreamEvent>
}

// ---- 会话持久化 ----

/** 会话持久化抽象 */
export interface ISessionStore {
  appendMessage(sessionId: string, message: unknown): Promise<void>
  loadSession(sessionId: string): Promise<unknown[]>
  listSessions(): Promise<Array<{ id: string; title: string; updatedAt: number }>>
  deleteSession(sessionId: string): Promise<void>
}

// ---- 事件发送 ----

/** 事件发送抽象（替代 Electron.WebContents） */
export interface IEventSender {
  send(channel: string, data: unknown): void
  isDestroyed?(): boolean
}

// ---- 权限管理 ----

/** 权限管理抽象 */
export interface IPermissionManager {
  needsApproval(toolName: string, toolInput?: Record<string, unknown>): boolean
  requestApproval(conversationId: string, toolName: string, toolInput: Record<string, unknown>): Promise<boolean>
  getPlanModeRejection(toolName: string): string | null
}

// ---- 上下文管理 ----

/** 上下文管理抽象 */
export interface IContextManager {
  shouldCompact(messages: Message[], modelId: string): boolean
  compact(messages: Message[], gateway: IStreamProvider, model: string, provider: string, systemPrompt?: string): Promise<CompactResult>
  reactiveCompact(messages: Message[]): Message[]
  estimateTokens(messages: Message[], modelId?: string): number
  trackTokenUsage(inputTokens: number, outputTokens: number): void
  getContextWindowForModel(modelId: string): number
  getMicrocompactConfig(): { gapMinutes: number; keepRecent: number }
  getConfig(): AgentRuntimeConfig
}

// ---- 循环检测 ----

/** 循环检测接口（内部使用） */
export interface ILoopDetector {
  record(toolName: string, toolInput: Record<string, unknown>): void
  isLooping(): boolean
  reset(): void
}

// ---- Hook 注册表 ----

/** 钩子注册表抽象 */
export interface IHookRegistry {
  emit(event: string, context: Record<string, unknown>): Promise<void>
}

// ---- 可观测性 ----

/** Generation span 追踪 */
export interface IGenerationSpan {
  update(data: Record<string, unknown>): void
  end(): void
}

/** Tool span 追踪 */
export interface IToolSpan {
  update(data: Record<string, unknown>): void
  end(): void
}

/** Trace 上下文 */
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

/** 可观测性抽象（替代直接引用 langfuse-observer） */
export interface IObservability {
  startTrace(conversationId: string, model: string, userMessage: string, workingDir: string, parentSpan?: unknown): void
  endTrace(conversationId: string, usage: TokenUsage, turnCount: number, error: boolean, messages?: Message[]): void
  getActiveTrace(conversationId: string): ITraceContext | undefined
}
