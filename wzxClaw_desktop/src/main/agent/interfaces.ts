// ============================================================
// Agent 依赖注入接口
// 所有依赖通过接口类型注入，便于测试 mock 和未来替换实现
// ============================================================

import type { StreamEvent, LLMProvider, Message, ToolCall } from '../../shared/types'
import type { StreamOptions } from '../llm/types'
import type { Tool } from '../tools/tool-interface'
import type { CompactResult } from '../context/context-manager'
import type { AgentRuntimeConfig } from './runtime-config'

// ---- LLM 网关 ----

export interface ILLMGateway {
  stream(options: StreamOptions): AsyncGenerator<StreamEvent>
  detectProvider(model: string): LLMProvider
}

// ---- 工具注册表 ----

export interface IToolRegistry {
  get(name: string): Tool | undefined
  getAll(): Tool[]
  getDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  isReadOnly(name: string): boolean
}

// ---- 权限管理 ----

export interface IPermissionManager {
  needsApproval(toolName: string, toolInput?: Record<string, unknown>): boolean
  requestApproval(conversationId: string, toolName: string, toolInput: Record<string, unknown>, sender: Electron.WebContents): Promise<boolean>
  getPlanModeRejection(toolName: string): string | null
}

// ---- 上下文管理 ----

export interface IContextManager {
  shouldCompact(messages: Message[], modelId: string): boolean
  compact(messages: Message[], gateway: ILLMGateway, model: string, provider: string, systemPrompt?: string): Promise<CompactResult>
  reactiveCompact(messages: Message[]): Message[]
  estimateTokens(messages: Message[], modelId?: string): number
  trackTokenUsage(inputTokens: number, outputTokens: number): void
  getContextWindowForModel(modelId: string): number
  getConfig(): AgentRuntimeConfig
}

// ---- Hook 注册表 ----

export interface IHookRegistry {
  emit(event: string, context: Record<string, unknown>): Promise<void>
}

// ---- 文件历史 ----

export interface IFileHistoryManager {
  snapshot(filePath: string, toolCallId: string): Promise<void>
  getByToolCallId(toolCallId: string): { filePath: string; content: string; timestamp: number; toolCallId: string } | undefined
}
