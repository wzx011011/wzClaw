// ============================================================
// Brain Bridge — 桌面端到 brain 包的桥接层
//
// 核心职责：
//   1. 创建 brain 包的 AgentLoop 实例（通过 createAgentLoop 工厂）
//   2. 创建桌面端特有的 IToolExecutor 适配器
//   3. 在 run() 时按需创建 IEventSender（需要 WebContents）
//
// 使用方式：
//   import { createDesktopAgentLoop, DesktopAgentLoop } from './brain-bridge'
//   const loop = createDesktopAgentLoop({ gateway, toolRegistry, ... })
//   const agentLoop = loop.getAgentLoop() // brain 包的 AgentLoop
// ============================================================

import {
  AgentLoop,
  createAgentLoop,
  type AgentLoopDeps,
  type AgentEvent,
  type AgentConfig,
  type IEventSender,
  type IToolExecutor,
  BRAIN_CHANNELS,
} from '@wzxclaw/brain'
import type { LLMGateway } from './llm/gateway'
import type { ToolRegistry } from './tools/tool-registry'
import type { PermissionManager } from './permission/permission-manager'
import type { ContextManager } from './context/context-manager'
import type { HookRegistry } from './hooks/hook-registry'
import type { FileHistoryManager } from './file-history/file-history-manager'
import type { Message } from '../shared/types'
import type { Workspace } from '../shared/types'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { TodoWriteTool } from './tools/todo-write'
import {
  DesktopEventSender,
  DesktopObservability,
  DesktopLogger,
  DesktopToolExecutor,
  DesktopStreamProvider,
} from './brain-adapters'
import { ToolResultReplacementState } from './context/tool-result-storage'
import { getActiveTrace } from './observability/langfuse-observer'
import { truncateToolResult } from './context/tool-result-budget'
import { flattenToolOutput } from './tools/tool-interface'
import { ContextManager as ContextManagerClass } from './context/context-manager'
import { maybePersistLargeToolResult } from './context/tool-result-storage'
import path from 'path'

/**
 * 桌面端 AgentLoop 包装器
 *
 * 封装 brain 包的 AgentLoop，增加桌面端特有的功能：
 * - TodoWrite 恢复
 * - WebContents sender 创建
 * - IToolExecutor 注入
 * - activeWorkspace 管理
 */
export class DesktopAgentLoop {
  private brainLoop: AgentLoop
  private gateway: LLMGateway
  private toolRegistry: ToolRegistry
  private permissionManager: PermissionManager
  private contextManager: ContextManager
  private hookRegistry?: HookRegistry
  private historyManager?: FileHistoryManager

  /** Active workspace context — injected into system prompt when set */
  activeWorkspace: Workspace | null = null

  /** 当前是否正在运行 */
  get isRunning(): boolean {
    return this.brainLoop.isRunning
  }

  constructor(deps: {
    gateway: LLMGateway
    toolRegistry: ToolRegistry
    permissionManager: PermissionManager
    contextManager: ContextManager
    hookRegistry?: HookRegistry
    historyManager?: FileHistoryManager
  }) {
    this.gateway = deps.gateway
    this.toolRegistry = deps.toolRegistry
    this.permissionManager = deps.permissionManager
    this.contextManager = deps.contextManager
    this.hookRegistry = deps.hookRegistry
    this.historyManager = deps.historyManager

    // 创建 brain 包的 AgentLoop（通过工厂函数）
    this.brainLoop = createAgentLoop({
      gateway: new DesktopStreamProvider(deps.gateway),
      contextManager: deps.contextManager as import('@wzxclaw/brain').IContextManager,
      observability: new DesktopObservability(),
      hookRegistry: deps.hookRegistry ? new DesktopHookRegistryAdapter(deps.hookRegistry) : undefined,
      logger: undefined, // 每次 run() 创建新的 session-scoped logger
    })
  }

  /**
   * Run the agent loop for a user message.
   * 适配桌面端的 run() 签名（含 WebContents sender 和 images）
   */
  async *run(
    userMessage: string,
    config: AgentConfig,
    sender?: Electron.WebContents,
    images?: import('../shared/types').ImageContent[],
  ): AsyncGenerator<AgentEvent> {
    // 恢复上次会话的 todos（如有持久化文件）
    const todoTool = this.toolRegistry.get('TodoWrite') as TodoWriteTool | undefined
    if (todoTool && config.conversationId) {
      const saved = await TodoWriteTool.loadForSession(config.conversationId)
      if (saved.length > 0) {
        todoTool.setCurrentTodos(saved)
        if (sender && !sender.isDestroyed()) {
          sender.send(IPC_CHANNELS['todo:updated'], { todos: saved })
        }
      }
    }

    // 创建 session-scoped logger
    const logger = new DesktopLogger(config.conversationId)

    // 创建 IEventSender（包装 WebContents）
    const eventSender = sender ? new DesktopEventSender(sender) : undefined

    // 创建工具结果替换状态（Anthropic prompt cache 稳定性）
    const replacementState = config.provider === 'anthropic' ? new ToolResultReplacementState() : undefined

    // 创建桌面端特有的工具执行器
    const toolExecutor = new DesktopToolExecutor(
      this.toolRegistry,
      this.permissionManager,
      this.hookRegistry,
      this.historyManager,
      {
        conversationId: config.conversationId,
        workingDirectory: config.workingDirectory,
        workspaceId: this.activeWorkspace?.id,
      },
      undefined as unknown as AbortSignal, // 将在 run() 内设置
      eventSender,
      replacementState,
    )

    // 设置原始 WebContents 引用（权限审批需要）
    if (sender) {
      toolExecutor.setRawSender(sender)
    }

    // 构建 system prompt（桌面端自己构建，因为涉及 Electron 路径和 workspace）
    // 注意：brain 包的 AgentLoop 使用 config.systemPrompt，
    // 所以桌面端在传入 config 前应已完成 system prompt 构建
    // 这里 config.systemPrompt 已经构建好了

    // 代理 run() 调用到 brain 包的 AgentLoop
    // 但我们需要处理 brain 包 run() 签名（需要 sender + toolExecutor）
    // 直接使用 brainLoop 的内部方法
    yield* this.brainLoop.run(
      userMessage,
      config,
      eventSender ?? undefined,
      toolExecutor,
    )
  }

  // ---- 公共 API（保持与原 AgentLoop 兼容的签名） ----

  cancel(): void {
    this.brainLoop.cancel()
  }

  reset(): void {
    this.brainLoop.reset()
  }

  getMessages(): Message[] {
    return this.brainLoop.getMessages()
  }

  replaceMessages(messages: Message[]): void {
    this.brainLoop.replaceMessages(messages)
  }

  /** 获取内部 brain AgentLoop 实例（高级用途） */
  getBrainLoop(): AgentLoop {
    return this.brainLoop
  }

  /**
   * 恢复上下文（会话加载时使用）
   */
  async restoreContext(
    rawMessages: unknown[],
    config: Pick<AgentConfig, 'model' | 'provider' | 'systemPrompt' | 'workingDirectory' | 'projectRoots'>,
  ): Promise<{ messageCount: number; compacted: boolean; beforeTokens: number; afterTokens: number }> {
    const messages = (rawMessages as Array<Record<string, unknown>>)
      .filter((m) => m.type !== 'meta' && m.role != null)
      .map((m) => m as unknown as Message)

    const beforeTokens = this.contextManager.estimateTokens(messages)

    if (this.contextManager.shouldCompact(messages, config.model)) {
      const result = await this.contextManager.compact(
        messages,
        this.gateway,
        config.model,
        config.provider as 'openai' | 'anthropic',
        config.systemPrompt ?? '',
      )
      if (result.summary) {
        const recentMessages = messages.slice(-result.keptRecentCount)
        this.brainLoop.replaceMessages([
          {
            role: 'user',
            content: result.summaryMessageContent,
            timestamp: Date.now(),
          },
          ...recentMessages,
        ] as Message[])
        const afterTokens = this.contextManager.estimateTokens(this.brainLoop.getMessages())
        return { messageCount: this.brainLoop.getMessages().length, compacted: true, beforeTokens, afterTokens }
      }
    }

    this.brainLoop.replaceMessages(messages)
    return { messageCount: messages.length, compacted: false, beforeTokens, afterTokens: beforeTokens }
  }
}

// ============================================================
// DesktopHookRegistryAdapter — 适配桌面端 HookRegistry 为 brain 的 IHookRegistry
// ============================================================

class DesktopHookRegistryAdapter implements import('@wzxclaw/brain').IHookRegistry {
  constructor(private registry: HookRegistry) {}

  async emit(event: string, context: Record<string, unknown>): Promise<import('@wzxclaw/brain').IHookResult | void> {
    const result = await this.registry.emit(event as import('./hooks/hook-registry').HookEvent, context)
    // 桌面端 HookResult 和 brain 的 IHookResult 结构一致
    return result
  }
}

// ============================================================
// 工厂函数 — 创建 DesktopAgentLoop 实例
// ============================================================

export interface DesktopAgentLoopDeps {
  gateway: LLMGateway
  toolRegistry: ToolRegistry
  permissionManager: PermissionManager
  contextManager: ContextManager
  hookRegistry?: HookRegistry
  historyManager?: FileHistoryManager
}

/**
 * 创建桌面端的 AgentLoop 实例（桥接到 brain 包）
 *
 * 使用示例：
 * ```ts
 * const loop = createDesktopAgentLoop({
 *   gateway,
 *   toolRegistry,
 *   permissionManager,
 *   contextManager,
 *   hookRegistry,
 * })
 * const runtime = runtimes.getOrCreate(sessionId)
 * for await (const event of runtime.run(message, config, sender)) { ... }
 * ```
 */
export function createDesktopAgentLoop(deps: DesktopAgentLoopDeps): DesktopAgentLoop {
  return new DesktopAgentLoop(deps)
}
