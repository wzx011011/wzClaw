// ============================================================
// @wzxclaw/brain — Barrel Export
// ============================================================

// 核心类型
export type {
  ContentBlock,
  TextContentBlock,
  ToolUseContentBlock,
  ThinkingContentBlock,
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  ImageContent,
  ToolCall,
  ToolResult,
  ToolDefinition,
  StreamEvent,
  TextDeltaEvent,
  ThinkingDeltaEvent,
  ThinkingBlockDoneEvent,
  ToolUseStartEvent,
  ToolUseDeltaEvent,
  ToolUseEndEvent,
  StreamErrorEvent,
  StreamDoneEvent,
  TokenUsage,
  LLMProvider,
  CompactResult,
  Project,
  Workspace,
} from './types.js'

// DI 接口
export type {
  IToolExecutor,
  IToolExecutionContext,
  IToolExecutionResult,
  IStreamOptions,
  IStreamProvider,
  ISessionStore,
  IEventSender,
  IPermissionManager,
  IContextManager,
  ILoopDetector,
  IHookRegistry,
  IObservability,
  ITraceContext,
  IGenerationSpan,
  IToolSpan,
} from './interfaces.js'

// Agent 类型
export type {
  AgentEvent,
  AgentTextEvent,
  AgentThinkingEvent,
  AgentToolCallEvent,
  AgentToolCallPreviewEvent,
  AgentToolResultEvent,
  AgentErrorEvent,
  AgentDoneEvent,
  AgentCompactedEvent,
  AgentTurnEndEvent,
  AgentToolProgressEvent,
  AgentConfig,
} from './agent/types.js'

// Agent 配置
export {
  DEFAULT_RUNTIME_CONFIG,
  createRuntimeConfig,
} from './agent/runtime-config.js'

export type { AgentRuntimeConfig } from './agent/runtime-config.js'

// Agent 模块
export { ConversationManager } from './agent/conversation-manager.js'
export type { MessagePriority } from './agent/conversation-manager.js'

export { MessageBuilder } from './agent/message-builder.js'

export { LoopDetector } from './agent/loop-detector.js'

export { StreamingToolExecutor } from './agent/streaming-tool-executor.js'
export type { ToolExecResult } from './agent/streaming-tool-executor.js'

// LLM 模块
export type {
  StreamOptions,
  LLMAdapter,
  ProviderConfig,
} from './llm/types.js'

export {
  PromptTooLongError,
  AuthError,
  classifyError,
  withRetry,
} from './llm/retry.js'

export type {
  RetryInfo,
  WithRetryOptions,
} from './llm/retry.js'
