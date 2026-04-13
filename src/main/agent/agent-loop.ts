// ============================================================
// AgentLoop — 多轮 LLM 对话编排器
// 职责：循环控制 + 上下文压缩 + 事件分发
// 具体工作委托给 SystemPromptBuilder / TurnManager / StreamPhase
// 消息管理委托给 ConversationManager
// ============================================================

import type { LLMGateway } from '../llm/gateway'
import type { ToolRegistry } from '../tools/tool-registry'
import type { PermissionManager } from '../permission/permission-manager'
import type { Message } from '../../shared/types'
import { MAX_AGENT_TURNS } from '../../shared/constants'
import { ContextManager } from '../context/context-manager'
import type { HookRegistry } from '../hooks/hook-registry'
import type { AgentEvent, AgentConfig } from './types'
import { PromptTooLongError } from '../llm/retry'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { FileHistoryManager } from '../file-history/file-history-manager'
import { buildSystemPrompt } from './system-prompt-builder'
import { TurnManager } from './turn-manager'
import { ConversationManager } from './conversation-manager'
import { DebugLogger, cleanOldDebugFiles, cleanOldMediaFiles } from '../utils/debug-logger'
import { TodoWriteTool } from '../tools/todo-write'

export class AgentLoop {
  private conversation = new ConversationManager()
  private abortController: AbortController | null = null
  private turnManager = new TurnManager()

  constructor(
    private gateway: LLMGateway,
    private toolRegistry: ToolRegistry,
    private permissionManager: PermissionManager,
    private contextManager: ContextManager,
    private hookRegistry?: HookRegistry,
    private historyManager?: FileHistoryManager
  ) {}

  /**
   * Run the agent loop for a user message.
   * Yields AgentEvent instances as the conversation progresses.
   */
  async *run(
    userMessage: string,
    config: AgentConfig,
    sender?: Electron.WebContents
  ): AsyncGenerator<AgentEvent> {
    await this.hookRegistry?.emit('session-start', { conversationId: config.conversationId })

    // 每次 run() 创建新的调试日志（session 级别），并清理旧文件
    const debugLogger = new DebugLogger(config.conversationId)
    cleanOldDebugFiles().catch(() => {/* ignore */})
    cleanOldMediaFiles().catch(() => {/* ignore */})

    const maxTurns = config.maxTurns ?? MAX_AGENT_TURNS
    this.abortController = new AbortController()
    this.turnManager.reset()

    // 恢复上次会话的 todos（如有持久化文件）
    const todoTool = this.toolRegistry.get('TodoWrite') as TodoWriteTool | undefined
    if (todoTool && config.workingDirectory) {
      const saved = await TodoWriteTool.loadFromDir(config.workingDirectory)
      if (saved.length > 0) todoTool.setCurrentTodos(saved)
    }

    // 反应式压缩熔断器
    const MAX_REACTIVE_COMPACTS = 2
    let reactiveCompactCount = 0

    // 追加用户消息
    this.conversation.appendUserMessage(userMessage)

    // 构建系统提示（委托给 SystemPromptBuilder）
    const systemPrompt = await buildSystemPrompt(config)
    const toolDefinitions = this.toolRegistry.getDefinitions().map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }))

    // 创建工具执行函数（闭包捕获所有依赖）
    const executeTool = this.turnManager.createExecuteToolFn(
      this.toolRegistry,
      this.permissionManager,
      this.contextManager,
      this.hookRegistry,
      this.historyManager,
      config,
      this.abortController.signal,
      sender,
    )

    let totalUsage = { inputTokens: 0, outputTokens: 0 }
    let turnCount = 0

    // ---- 主循环 ----
    let toolsDisabled = false  // 降级标志：上下文过长时禁用工具（用局部变量而非破坏原数组）
    for (let turn = 0; turn < maxTurns; turn++) {
      turnCount++

      // 上下文压缩检查（LLM 调用前）
      if (this.contextManager.shouldCompact(this.conversation.getMutableMessages(), config.model)) {
        const compacted = await this.doCompaction(config)
        if (compacted) {
          debugLogger.log('COMPACT', 'auto compaction triggered')
          yield compacted
        }
      }

      debugLogger.log('TURN', `start turn ${turn + 1}/${maxTurns}`)

      // 执行一轮 turn（委托给 TurnManager）
      let turnResult
      try {
        turnResult = await this.turnManager.executeTurn(
          {
            turnIndex: turn,
            conversation: this.conversation,
            config,
            systemPrompt,
            toolDefinitions: toolsDisabled ? [] : toolDefinitions,
            abortSignal: this.abortController.signal,
            sender,
          },
          this.gateway,
          executeTool,
          this.toolRegistry.isReadOnly.bind(this.toolRegistry),
        )
      } catch (streamErr) {
        // 分层错误恢复：
        //   1. 反应式压缩（保留最近消息，重试）
        //   2. 降级：移除工具定义，纯对话模式重试（不再调用工具，减少 token）
        //   3. 最终失败
        if (streamErr instanceof PromptTooLongError && reactiveCompactCount < MAX_REACTIVE_COMPACTS) {
          reactiveCompactCount++
          const beforeTokens = this.contextManager.estimateTokens(this.conversation.getMutableMessages())
          const compacted = this.contextManager.reactiveCompact(this.conversation.getMutableMessages())
          this.conversation.loadFromExternal(compacted)
          const afterTokens = this.contextManager.estimateTokens(this.conversation.getMutableMessages())

          if (sender && !sender.isDestroyed()) {
            sender.send(IPC_CHANNELS['session:compacted'], { beforeTokens, afterTokens, auto: true })
          }

          // 不消耗 turn 槽位，重试
          turn--
          turnCount--
          continue
        } else if (streamErr instanceof PromptTooLongError && !toolsDisabled) {
          // 层级 2：降级到纯对话模式（不修改原数组，用标志位，压缩成功后可自动恢复）
          toolsDisabled = true
          yield { type: 'agent:error', error: 'Context too long — retrying in text-only mode (tools disabled)', recoverable: true }
          turn--
          turnCount--
          continue
        } else {
          yield { type: 'agent:error', error: 'Context too long — use /compact to reduce context size', recoverable: true }
          await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
          return
        }
      }

      // 转发 turn 事件
      for (const event of turnResult.events) {
        yield event
      }

      if (turnResult.hadError) {
        debugLogger.log('ERROR', 'turn had error, stopping')
        debugLogger.close()
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
        return
      }

      // 累计 token 用量
      totalUsage.inputTokens += turnResult.usage.inputTokens
      totalUsage.outputTokens += turnResult.usage.outputTokens
      this.contextManager.trackTokenUsage(turnResult.usage.inputTokens, turnResult.usage.outputTokens)

      // 无工具调用 → 正常结束
      if (turnResult.shouldStop) {
        debugLogger.log('DONE', `completed in ${turnCount} turns`, { inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens })
        debugLogger.close()
        yield { type: 'agent:done', usage: totalUsage, turnCount }
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
        return
      }
    }

    // 超过最大轮次
    debugLogger.log('ERROR', `max turns exceeded (${turnCount})`)
    debugLogger.close()
    yield { type: 'agent:error', error: `Max agent turns exceeded (${turnCount})`, recoverable: true }
    yield { type: 'agent:done', usage: totalUsage, turnCount }
    await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
  }

  /** 执行主动压缩，返回 compacted 事件或 null */
  private async doCompaction(config: AgentConfig): Promise<AgentEvent | null> {
    await this.hookRegistry?.emit('pre-compact', { conversationId: config.conversationId })
    const messages = this.conversation.getMutableMessages()
    const result = await this.contextManager.compact(
      messages, this.gateway, config.model, config.provider, config.systemPrompt
    )
    await this.hookRegistry?.emit('post-compact', { conversationId: config.conversationId })

    if (result.summary) {
      const recentMessages = messages.slice(-result.keptRecentCount)
      this.conversation.replaceWithSummary(result.summary, recentMessages)

      return {
        type: 'agent:compacted',
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        auto: true,
      }
    }
    return null
  }

  // ---- 公共 API（保持签名不变） ----

  cancel(): void {
    this.abortController?.abort()
    this.turnManager.reset()
  }

  reset(): void {
    this.conversation.clear()
    this.turnManager.reset()
    this.abortController = null
  }

  getMessages(): Message[] {
    return this.conversation.getMessages()
  }

  replaceMessages(messages: Message[]): void {
    this.conversation.loadFromExternal(messages)
  }

  async restoreContext(
    rawMessages: unknown[],
    config: Pick<AgentConfig, 'model' | 'provider' | 'systemPrompt' | 'workingDirectory'>
  ): Promise<{ messageCount: number; compacted: boolean; beforeTokens: number; afterTokens: number }> {
    const messages = (rawMessages as Array<Record<string, unknown>>)
      .filter((m) => m.type !== 'meta' && m.role != null)
      .map((m) => m as unknown as Message)

    const beforeTokens = this.contextManager.estimateTokens(messages)

    if (this.contextManager.shouldCompact(messages, config.model)) {
      const result = await this.contextManager.compact(
        messages, this.gateway, config.model,
        config.provider as 'openai' | 'anthropic',
        config.systemPrompt ?? ''
      )
      if (result.summary) {
        const recentMessages = messages.slice(-result.keptRecentCount)
        this.conversation.replaceWithSummary(result.summary, recentMessages)
        const afterTokens = this.contextManager.estimateTokens(this.conversation.getMutableMessages())
        return { messageCount: this.conversation.length, compacted: true, beforeTokens, afterTokens }
      }
    }

    this.conversation.loadFromExternal(messages)
    return { messageCount: messages.length, compacted: false, beforeTokens, afterTokens: beforeTokens }
  }
}
