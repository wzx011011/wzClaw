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
