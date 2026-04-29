// ============================================================
// AgentLoop — 多轮 LLM 对话编排器
// 职责：循环控制 + 上下文压缩 + 事件分发
// 具体工作委托给 SystemPromptBuilder / TurnManager / StreamPhase
// 消息管理委托给 ConversationManager
//
// v2: 事件通过 yield* 从 TurnManager 逐条穿透到消费者
// ============================================================

import type { LLMGateway } from '../llm/gateway'
import type { ToolRegistry } from '../tools/tool-registry'
import type { PermissionManager } from '../permission/permission-manager'
import type { Message, Workspace } from '../../shared/types'
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
import { DebugLogger } from '../utils/debug-logger'
import { TodoWriteTool } from '../tools/todo-write'
import { startTrace, endTrace, getActiveTrace } from '../observability/langfuse-observer'
import { maybeTimeBasedMicrocompact } from '../context/microcompact'

export class AgentLoop {
  private conversation = new ConversationManager()
  private abortController: AbortController | null = null
  private turnManager = new TurnManager()
  private _recentOutputTokens: number[] = []

  /** Active workspace context — injected into system prompt when set */
  activeWorkspace: Workspace | null = null

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

    // 每次 run() 创建新的调试日志（session 级别）
    const debugLogger = new DebugLogger(config.conversationId)

    // Langfuse：每次 run() 开启一条 trace（若存在父 span 则以 nested span 模式记录）
    startTrace(config.conversationId, config.model, userMessage, config.workingDirectory, config.langfuseParentSpan)

    // 安全天花板：子 Agent 使用 config.maxTurns，主对话不设上限（靠自然终止）
    const maxTurns = config.maxTurns  // 子 Agent 传入具体值，主对话为 undefined
    const safetyCeiling = MAX_AGENT_TURNS  // 200，意外死循环的最后防线
    this.abortController = new AbortController()
    this.turnManager.reset()
    this._recentOutputTokens = []

    // 恢复上次会话的 todos（如有持久化文件）
    const todoTool = this.toolRegistry.get('TodoWrite') as TodoWriteTool | undefined
    if (todoTool && this.activeWorkspace) {
      const saved = await TodoWriteTool.loadForWorkspace(this.activeWorkspace.id)
      if (saved.length > 0) {
        todoTool.setCurrentTodos(saved)
        // Notify renderer so the todo panel shows restored state immediately
        if (sender && !sender.isDestroyed()) {
          sender.send(IPC_CHANNELS['todo:updated'], { todos: saved })
        }
      }
    }

    // 反应式压缩熔断器
    const MAX_REACTIVE_COMPACTS = 2
    let reactiveCompactCount = 0

    // 追加用户消息
    this.conversation.appendUserMessage(userMessage)

    // 构建系统提示（委托给 SystemPromptBuilder）
    const systemPrompt = await buildSystemPrompt(config, this.activeWorkspace)
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
      this.activeWorkspace?.id,
    )

    let totalUsage = { inputTokens: 0, outputTokens: 0 }
    let turnCount = 0
    let stopHookCooldown = 0  // 防止 blockingError → stop hook → 无限循环

    // ---- 主循环 ----
    // 参考 Claude Code：主对话不设硬性轮数上限，靠以下条件自然终止：
    //   1. LLM 不再调用工具 (shouldStop)
    //   2. 上下文溢出经压缩仍无法恢复 (fatal error)
    //   3. 用户中止 (abort)
    //   4. 安全天花板 (200 轮) — 意外死循环的最后防线
    // 子 Agent 仍通过 config.maxTurns 限制（默认 10，最大 20）
    let toolsDisabled = false  // 降级标志：上下文过长时禁用工具（用局部变量而非破坏原数组）
    // eslint-disable-next-line no-constant-condition
    while (true) {
      turnCount++

      // 安全天花板检查
      if (turnCount > safetyCeiling) {
        debugLogger.log('ERROR', `safety ceiling reached (${turnCount})`)
        debugLogger.close()
        yield { type: 'agent:error', error: `Safety ceiling reached (${turnCount} turns). This should not happen — the conversation should end naturally.`, recoverable: true }
        yield { type: 'agent:done', usage: totalUsage, turnCount, model: config.model }
        endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
        return
      }

      // 子 Agent 轮数限制检查
      if (maxTurns && turnCount > maxTurns) {
        debugLogger.log('ERROR', `sub-agent max turns reached (${turnCount}/${maxTurns})`)
        debugLogger.close()
        yield { type: 'agent:error', error: `Sub-agent max turns exceeded (${turnCount})`, recoverable: true }
        yield { type: 'agent:done', usage: totalUsage, turnCount, model: config.model }
        endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
        return
      }

      // Time-based microcompact：清理旧工具结果（provider-agnostic，无 API 调用）
      const mcResult = maybeTimeBasedMicrocompact(this.conversation.getMutableMessages())
      if (mcResult.result.didCompact) {
        this.conversation.loadFromExternal(mcResult.messages)
        debugLogger.log('MICROCOMPACT', `cleared ${mcResult.result.clearedCount} old tool results (~${mcResult.result.charsSaved} chars, gap ${Math.round(mcResult.result.gapMinutes)}min)`)
      }

      // 上下文压缩检查（LLM 调用前）
      if (this.contextManager.shouldCompact(this.conversation.getMutableMessages(), config.model)) {
        const compacted = await this.doCompaction(config)
        if (compacted) {
          debugLogger.log('COMPACT', 'auto compaction triggered')
          getActiveTrace(config.conversationId)?.evalCollector.recordCompaction()
          yield compacted
          // Compaction succeeded — only re-enable tools if context is now below threshold
          if (toolsDisabled && !this.contextManager.shouldCompact(this.conversation.getMutableMessages(), config.model)) {
            toolsDisabled = false
          }
        }
      }

      // Eval: 记录上下文压力
      const _eval = getActiveTrace(config.conversationId)?.evalCollector
      if (_eval) {
        const estTokens = this.contextManager.estimateTokens(this.conversation.getMutableMessages(), config.model)
        const ctxWindow = this.contextManager.getContextWindowForModel(config.model)
        _eval.recordContextPressure(estTokens, ctxWindow)
      }

      debugLogger.log('TURN', `start turn ${turnCount}${maxTurns ? `/${maxTurns}` : ''}`)

      // 执行一轮 turn（事件通过 yield* 逐条穿透）
      let turnResult
      try {
        turnResult = yield* this.turnManager.executeTurn(
          {
            turnIndex: turnCount - 1,
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
          getActiveTrace(config.conversationId)?.evalCollector.recordErrorRecovery('reactive_compact')
          getActiveTrace(config.conversationId)?.evalCollector.recordCompaction()
          const beforeTokens = this.contextManager.estimateTokens(this.conversation.getMutableMessages())
          const compacted = this.contextManager.reactiveCompact(this.conversation.getMutableMessages())
          this.conversation.loadFromExternal(compacted)
          const afterTokens = this.contextManager.estimateTokens(this.conversation.getMutableMessages())

          if (sender && !sender.isDestroyed()) {
            sender.send(IPC_CHANNELS['session:compacted'], { beforeTokens, afterTokens, auto: true })
          }

          // 不消耗 turn 槽位，重试
          if (turnCount > 0) turnCount--
          continue
        } else if (streamErr instanceof PromptTooLongError && !toolsDisabled) {
          // 层级 2：降级到纯对话模式（不修改原数组，用标志位，压缩成功后可自动恢复）
          getActiveTrace(config.conversationId)?.evalCollector.recordErrorRecovery('tools_disabled')
          toolsDisabled = true
          yield { type: 'agent:error', error: 'Context too long — retrying in text-only mode (tools disabled)', recoverable: true }
          if (turnCount > 0) turnCount--
          continue
        } else {
          debugLogger.log('ERROR', 'context too long, all recovery exhausted')
          debugLogger.close()
          getActiveTrace(config.conversationId)?.evalCollector.recordErrorRecovery('fatal')
          yield { type: 'agent:error', error: 'Context too long — use /compact to reduce context size', recoverable: true }
          endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
          await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
          return
        }
      }

      if (turnResult.hadError) {
        debugLogger.log('ERROR', 'turn had error, stopping')
        debugLogger.close()
        endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
        return
      }

      // 累计 token 用量
      totalUsage.inputTokens += turnResult.usage.inputTokens
      totalUsage.outputTokens += turnResult.usage.outputTokens

      this.contextManager.trackTokenUsage(turnResult.usage.inputTokens, turnResult.usage.outputTokens)

      // Eval: 记录 turn 输出 token
      getActiveTrace(config.conversationId)?.evalCollector.recordTurn(turnResult.usage.outputTokens)

      // 收益递减检测：暂时关闭
      // const DIMINISHING_WINDOW = 5
      // const DIMINISHING_THRESHOLD = 300
      // this._recentOutputTokens.push(turnResult.usage.outputTokens)
      // if (this._recentOutputTokens.length > DIMINISHING_WINDOW) {
      //   this._recentOutputTokens.shift()
      // }
      // if (this._recentOutputTokens.length >= DIMINISHING_WINDOW &&
      //     this._recentOutputTokens.every(t => t < DIMINISHING_THRESHOLD) && turnCount > DIMINISHING_WINDOW) {
      //   debugLogger.log('WARN', `diminishing returns: last ${DIMINISHING_WINDOW} turns all < ${DIMINISHING_THRESHOLD} output tokens`)
      //   yield { type: 'agent:error', error: `Agent appears stuck — low output over ${DIMINISHING_WINDOW} consecutive turns`, recoverable: true }
      //   yield { type: 'agent:done', usage: totalUsage, turnCount, model: config.model }
      //   endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
      //   await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
      //   return
      // }

      // Token 预算检查
      if (config.maxBudgetTokens > 0 && totalUsage.inputTokens > config.maxBudgetTokens) {
        debugLogger.log('WARN', `token budget exceeded: ${totalUsage.inputTokens} > ${config.maxBudgetTokens}`)
        yield { type: 'agent:error', error: `Token budget exceeded (${totalUsage.inputTokens.toLocaleString()} / ${config.maxBudgetTokens.toLocaleString()} input tokens)`, recoverable: true }
        yield { type: 'agent:done', usage: totalUsage, turnCount, model: config.model }
        endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
        return
      }

      // Stop hooks：turn 结束时执行，可阻止继续或注入提醒
      if (stopHookCooldown > 0) {
        stopHookCooldown--
      } else if (this.hookRegistry) {
        const WRITE_TOOLS = new Set(['FileWrite', 'FileEdit', 'Bash'])
        const hookResult = await this.hookRegistry.emit('turn-end', {
          conversationId: config.conversationId,
          turnInfo: {
            turnIndex: turnCount - 1,
            toolCalls: turnResult.toolNames,
            hadWrite: turnResult.toolNames.some(n => WRITE_TOOLS.has(n)),
            outputTokens: turnResult.usage.outputTokens,
          },
        })

        if (hookResult.preventContinuation) {
          debugLogger.log('HOOK', 'stop hook prevented continuation')
          debugLogger.close()
          yield { type: 'agent:done', usage: totalUsage, turnCount, model: config.model }
          endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
          await this.hookRegistry.emit('session-end', { conversationId: config.conversationId })
          return
        }

        if (hookResult.blockingError) {
          debugLogger.log('HOOK', `blocking error injected: ${hookResult.blockingError.substring(0, 80)}`)
          this.conversation.appendUserMessage(`[System] ${hookResult.blockingError}`)
          stopHookCooldown = 2  // 跳过 2 轮再重新评估，防止振荡
          continue
        }
      }

      // 无工具调用 → 正常结束
      if (turnResult.shouldStop) {
        debugLogger.log('DONE', `completed in ${turnCount} turns`, { inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens })
        debugLogger.close()
        yield { type: 'agent:done', usage: totalUsage, turnCount, model: config.model }
        endTrace(config.conversationId, totalUsage, turnCount, false, this.conversation.getMessages())
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
        return
      }
    }
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
    this._recentOutputTokens = []
  }

  getMessages(): Message[] {
    return this.conversation.getMessages()
  }

  replaceMessages(messages: Message[]): void {
    this.conversation.loadFromExternal(messages)
  }

  async restoreContext(
    rawMessages: unknown[],
    config: Pick<AgentConfig, 'model' | 'provider' | 'systemPrompt' | 'workingDirectory' | 'projectRoots'>
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
