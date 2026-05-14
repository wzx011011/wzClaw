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

// 常量
export {
  DEFAULT_MODELS,
  DEFAULT_MAX_TOKENS,
  MAX_AGENT_TURNS,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  TOOL_DEFS_CACHE_BOUNDARY,
} from './constants.js'

export type { ModelPreset } from './constants.js'

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

export { LLMGateway } from './llm/gateway.js'

export { OpenAIAdapter } from './llm/openai-adapter.js'

export { AnthropicAdapter } from './llm/anthropic-adapter.js'

export { CostTracker } from './llm/cost-tracker.js'
export type { SessionUsage } from './llm/cost-tracker.js'

export { getPricing } from './llm/model-cost.js'
export type { ModelPricing } from './llm/model-cost.js'
