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
  IHookResult,
  IObservability,
  ITraceContext,
  IGenerationSpan,
  IToolSpan,
  ILogger,
} from './interfaces.js'

// Channel 常量
export { BRAIN_CHANNELS } from './channels.js'
export type { BrainChannelName } from './channels.js'

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

export { AgentLoop } from './agent/agent-loop.js'

export { createAgentLoop } from './agent/agent-factory.js'
export type { AgentLoopDeps } from './agent/agent-factory.js'

export { TurnManager } from './agent/turn-manager.js'
export type { TurnInput, TurnResult } from './agent/turn-manager.js'

export { executeStreamPhase } from './agent/stream-phase.js'
export type { StreamPhaseMeta, ExecuteToolFn, StreamFn } from './agent/stream-phase.js'

export { buildBrainSystemPrompt } from './agent/system-prompt-builder.js'

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

// Context 模块
export type { CompactResult } from './context/types.js'

export { ContextManager } from './context/context-manager.js'

export {
  countTokens,
  countMessagesTokens,
} from './context/token-counter.js'

export {
  TOOL_RESULT_CLEARED_MESSAGE,
  maybeTimeBasedMicrocompact,
  maybeTokenPressureMicrocompact,
  resetMicrocompactState,
} from './context/microcompact.js'

export type {
  MicrocompactConfig,
  MicrocompactResult,
} from './context/microcompact.js'

export {
  truncateToolResult,
  enforceContextBudget,
} from './context/tool-result-budget.js'

export type { ToolResultEntry } from './context/tool-result-budget.js'

export {
  maybePersistLargeToolResult,
  cleanupToolResults,
  cleanupExpiredToolResults,
  ToolResultReplacementState,
} from './context/tool-result-storage.js'

export type { ToolResultStorageConfig } from './context/tool-result-storage.js'

export {
  wrapSystemReminder,
  buildTurnAttachments,
  FileChangeTracker,
} from './context/turn-attachments.js'

export type { TurnAttachmentContext } from './context/turn-attachments.js'

export {
  extractFilePathsFromToolCalls,
  extractRecentFilePaths,
  readFileContent,
  restoreFiles,
  formatRestoredFilesMessage,
} from './context/compact-file-restore.js'

export type { RestoredFile } from './context/compact-file-restore.js'
