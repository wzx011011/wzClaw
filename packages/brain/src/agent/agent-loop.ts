// ============================================================
// AgentLoop — 多轮 LLM 对话编排器（DI 版本）
// 职责：循环控制 + 上下文压缩 + 事件分发
//
// 零 Electron 依赖：所有外部依赖通过 DI 接口注入
// - IStreamProvider 替代 LLMGateway 直接引用
// - IContextManager 替代 ContextManager 类
// - IObservability 替代 langfuse-observer 直接调用
// - IEventSender 替代 Electron.WebContents
// - ILogger 替代 DebugLogger
//
// v2: 事件通过 yield* 从 TurnManager 逐条穿透到消费者
// ============================================================

import type { Message } from '../types.js'
import type {
  IStreamProvider,
  IContextManager,
  IObservability,
  IHookRegistry,
  IEventSender,
  ILogger,
  IToolExecutor,
} from '../interfaces.js'
import type { AgentEvent, AgentConfig } from './types.js'
import { MAX_AGENT_TURNS, SYSTEM_PROMPT_CACHE_BOUNDARY } from '../constants.js'
import { ConversationManager } from './conversation-manager.js'
import { TurnManager } from './turn-manager.js'
import { PromptTooLongError } from '../llm/retry.js'
import { BRAIN_CHANNELS } from '../channels.js'
import { maybeTimeBasedMicrocompact } from '../context/microcompact.js'
import { ToolResultReplacementState } from '../context/tool-result-storage.js'

/** No-op logger — 默认无日志 */
const noopLogger: ILogger = {
  log() {},
  close() {},
}

export class AgentLoop {
  private conversation = new ConversationManager()
  private abortController: AbortController | null = null
  private turnManager = new TurnManager()
  private _running: boolean = false

  /** 当前是否正在运行（run() 进入到 finally 退出之间为 true） */
  get isRunning(): boolean {
    return this._running
  }

  constructor(
    private gateway: IStreamProvider,
    private contextManager: IContextManager,
    private observability?: IObservability,
    private hookRegistry?: IHookRegistry,
    private logger?: ILogger,
  ) {}

  /**
   * Run the agent loop for a user message.
   * Yields AgentEvent instances as the conversation progresses.
   *
   * @param userMessage - 用户消息
   * @param config - Agent 配置
   * @param sender - 可选事件发送器（替代 Electron.WebContents）
   * @param toolExecutor - 可选工具执行器（外部注入）
   */
  async *run(
    userMessage: string,
    config: AgentConfig,
    sender?: IEventSender,
    toolExecutor?: IToolExecutor,
  ): AsyncGenerator<AgentEvent> {
    this._running = true
    try {
      const log = this.logger ?? noopLogger

      await this.hookRegistry?.emit('session-start', { conversationId: config.conversationId })

      // Langfuse：每次 run() 开启一条 trace
      this.observability?.startTrace(
        config.conversationId, config.model, userMessage,
        config.workingDirectory, config.langfuseParentSpan,
      )

      // 安全天花板：子 Agent 使用 config.maxTurns，主对话不设上限
      const maxTurns = config.maxTurns
      const safetyCeiling = MAX_AGENT_TURNS
      this.abortController = new AbortController()
      this.turnManager.reset()

      // 反应式压缩熔断器
      const MAX_REACTIVE_COMPACTS = 2
      let reactiveCompactCount = 0

      // 追加用户消息
      this.conversation.appendUserMessage(userMessage)

      // 构建系统提示（已由外部构建完成，直接使用 config.systemPrompt）
      const systemPrompt = config.systemPrompt + SYSTEM_PROMPT_CACHE_BOUNDARY

      // 获取工具定义
      const toolDefinitions = toolExecutor
        ? toolExecutor.getDefinitions().map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          }))
        : []

      // 创建工具执行函数（委托给注入的 IToolExecutor）
      const replacementState = config.provider === 'anthropic' ? new ToolResultReplacementState() : undefined
      const isReadOnly = toolExecutor ? (name: string) => toolExecutor.isReadOnly(name) : () => true

      const executeTool = toolExecutor
        ? async (toolCall: { id: string; name: string; input: Record<string, unknown> }) => {
            const _eval = this.observability?.getActiveTrace(config.conversationId)?.evalCollector
            try {
              const result = await toolExecutor.execute(toolCall.name, toolCall.input, {
                workingDirectory: config.workingDirectory,
                projectRoots: config.projectRoots,
                abortSignal: this.abortController!.signal,
                workspaceId: undefined,
                onSubAgentEvent: sender ? (event: Record<string, unknown>) => {
                  if (sender.isDestroyed?.()) return
                  if (event['type'] === 'agent:tool_call') {
                    sender.send(BRAIN_CHANNELS.SUB_TOOL_USE_START, {
                      parentToolCallId: toolCall.id,
                      id: event['toolCallId'],
                      name: event['toolName'],
                      input: event['input'],
                    })
                  } else if (event['type'] === 'agent:tool_result') {
                    sender.send(BRAIN_CHANNELS.SUB_TOOL_USE_END, {
                      parentToolCallId: toolCall.id,
                      id: event['toolCallId'],
                      output: event['output'],
                      isError: event['isError'],
                    })
                  } else if (event['type'] === 'agent:text') {
                    sender.send(BRAIN_CHANNELS.SUB_TEXT, {
                      parentToolCallId: toolCall.id,
                      content: event['content'],
                    })
                  }
                } : undefined,
              })
              _eval?.recordToolCall(toolCall.name, result.isError, false)
              return {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                output: result.output,
                truncatedOutput: result.output,
                isError: result.isError,
                loopDetected: false,
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              _eval?.recordToolCall(toolCall.name, true, false)
              return {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                output: msg,
                truncatedOutput: msg,
                isError: true,
                loopDetected: false,
              }
            }
          }
        : undefined

      let totalUsage = { inputTokens: 0, outputTokens: 0 }
      let turnCount = 0
      let stopHookCooldown = 0

      // ---- 主循环 ----
      let toolsDisabled = false
      // eslint-disable-next-line no-constant-condition
      while (true) {
        turnCount++

        // 安全天花板检查
        if (turnCount > safetyCeiling) {
          log.log('ERROR', `safety ceiling reached (${turnCount})`)
          log.close()
          yield { type: 'agent:error', error: `Safety ceiling reached (${turnCount} turns). This should not happen — the conversation should end naturally.`, recoverable: true }
          yield { type: 'agent:done', usage: totalUsage, turnCount, model: config.model }
          this.observability?.endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
          await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
          return
        }

        // 子 Agent 轮数限制检查
        if (maxTurns && turnCount > maxTurns) {
          log.log('ERROR', `sub-agent max turns reached (${turnCount}/${maxTurns})`)
          log.close()
          yield { type: 'agent:error', error: `Sub-agent max turns exceeded (${turnCount})`, recoverable: true }
          yield { type: 'agent:done', usage: totalUsage, turnCount, model: config.model }
          this.observability?.endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
          await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
          return
        }

        // Time-based microcompact
        const mcPartialConfig = this.contextManager.getMicrocompactConfig()
        const mcConfig = { tokenPressureThreshold: 0.80, ...mcPartialConfig }
        const mcResult = maybeTimeBasedMicrocompact(this.conversation.getMutableMessages(), mcConfig)
        if (mcResult.result.didCompact) {
          this.conversation.loadFromExternal(mcResult.messages)
          log.log('MICROCOMPACT', `cleared ${mcResult.result.clearedCount} old tool results`)
        }

        // 上下文压缩检查
        if (this.contextManager.shouldCompact(this.conversation.getMutableMessages(), config.model)) {
          const compacted = await this.doCompaction(config)
          if (compacted) {
            log.log('COMPACT', 'auto compaction triggered')
            this.observability?.getActiveTrace(config.conversationId)?.evalCollector.recordCompaction()
            yield compacted
            if (toolsDisabled && !this.contextManager.shouldCompact(this.conversation.getMutableMessages(), config.model)) {
              toolsDisabled = false
            }
          }
        }

        // Eval: 记录上下文压力
        const _eval = this.observability?.getActiveTrace(config.conversationId)?.evalCollector
        if (_eval) {
          const estTokens = this.contextManager.estimateTokens(this.conversation.getMutableMessages(), config.model)
          const ctxWindow = this.contextManager.getContextWindowForModel(config.model)
          _eval.recordContextPressure(estTokens, ctxWindow)
        }

        log.log('TURN', `start turn ${turnCount}${maxTurns ? `/${maxTurns}` : ''}`)

        // 执行一轮 turn
        let turnResult
        try {
          if (!executeTool) {
            // 无工具执行器 — 只做纯文本流
            turnResult = yield* this.turnManager.executeTurn(
              {
                turnIndex: turnCount - 1,
                conversation: this.conversation,
                config,
                systemPrompt,
                toolDefinitions: [],
                abortSignal: this.abortController.signal,
                replacementState: undefined,
              },
              this.gateway,
              async () => ({
                toolCallId: '', toolName: '', output: 'No tool executor',
                truncatedOutput: 'No tool executor', isError: true, loopDetected: false,
              }),
              isReadOnly,
            )
          } else {
            turnResult = yield* this.turnManager.executeTurn(
              {
                turnIndex: turnCount - 1,
                conversation: this.conversation,
                config,
                systemPrompt,
                toolDefinitions: toolsDisabled ? [] : toolDefinitions,
                abortSignal: this.abortController.signal,
                replacementState,
              },
              this.gateway,
              executeTool,
              isReadOnly,
            )
          }
        } catch (streamErr) {
          if (streamErr instanceof PromptTooLongError && reactiveCompactCount < MAX_REACTIVE_COMPACTS) {
            reactiveCompactCount++
            this.observability?.getActiveTrace(config.conversationId)?.evalCollector.recordErrorRecovery('reactive_compact')
            this.observability?.getActiveTrace(config.conversationId)?.evalCollector.recordCompaction()
            const beforeTokens = this.contextManager.estimateTokens(this.conversation.getMutableMessages())
            const compacted = this.contextManager.reactiveCompact(this.conversation.getMutableMessages())
            this.conversation.loadFromExternal(compacted)
            const afterTokens = this.contextManager.estimateTokens(this.conversation.getMutableMessages())

            log.log('REACTIVE_COMPACT', `PTL reactive: ${beforeTokens} -> ${afterTokens} tokens`)

            if (sender && !(sender.isDestroyed?.())) {
              sender.send(BRAIN_CHANNELS.SESSION_COMPACTED, { beforeTokens, afterTokens, auto: true })
            }

            if (turnCount > 0) turnCount--
            continue
          } else if (streamErr instanceof PromptTooLongError && !toolsDisabled) {
            this.observability?.getActiveTrace(config.conversationId)?.evalCollector.recordErrorRecovery('tools_disabled')
            toolsDisabled = true
            yield { type: 'agent:error', error: 'Context too long — retrying in text-only mode (tools disabled)', recoverable: true }
            if (turnCount > 0) turnCount--
            continue
          } else {
            log.log('ERROR', 'context too long, all recovery exhausted')
            log.close()
            this.observability?.getActiveTrace(config.conversationId)?.evalCollector.recordErrorRecovery('fatal')
            yield { type: 'agent:error', error: 'Context too long — use /compact to reduce context size', recoverable: true }
            this.observability?.endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
            await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
            return
          }
        }

        if (turnResult.hadError) {
          log.log('ERROR', 'turn had error, stopping')
          log.close()
          this.observability?.endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
          await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
          return
        }

        // 累计 token 用量
        totalUsage.inputTokens += turnResult.usage.inputTokens
        totalUsage.outputTokens += turnResult.usage.outputTokens

        this.contextManager.trackTokenUsage(turnResult.usage.inputTokens, turnResult.usage.outputTokens)

        // Eval: 记录 turn 输出 token
        this.observability?.getActiveTrace(config.conversationId)?.evalCollector.recordTurn(turnResult.usage.outputTokens)

        // Token 预算检查
        const budgetTokens = config.maxBudgetTokens ?? 0
        if (budgetTokens > 0 && totalUsage.inputTokens > budgetTokens) {
          log.log('WARN', `token budget exceeded: ${totalUsage.inputTokens} > ${budgetTokens}`)
          yield { type: 'agent:error', error: `Token budget exceeded (${totalUsage.inputTokens.toLocaleString()} / ${budgetTokens.toLocaleString()} input tokens)`, recoverable: true }
          yield { type: 'agent:done', usage: totalUsage, turnCount, model: config.model }
          this.observability?.endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
          await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
          return
        }

        // Stop hooks：turn 结束时执行
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

          if (hookResult?.preventContinuation) {
            log.log('HOOK', 'stop hook prevented continuation')
            log.close()
            yield { type: 'agent:done', usage: totalUsage, turnCount, model: config.model }
            this.observability?.endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
            await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
            return
          }

          if (hookResult?.blockingError) {
            const blockingError = hookResult.blockingError
            log.log('HOOK', `blocking error injected: ${blockingError.substring(0, 80)}`)
            this.conversation.appendUserMessage(`[System] ${blockingError}`)
            stopHookCooldown = 2
            continue
          }
        }

        // 无工具调用 → 正常结束
        if (turnResult.shouldStop) {
          log.log('DONE', `completed in ${turnCount} turns`, { inputTokens: totalUsage.inputTokens, outputTokens: totalUsage.outputTokens })
          log.close()
          yield { type: 'agent:done', usage: totalUsage, turnCount, model: config.model }
          this.observability?.endTrace(config.conversationId, totalUsage, turnCount, false, this.conversation.getMessages())
          await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
          return
        }
      }
    } finally {
      this._running = false
    }
  }

  /** 执行主动压缩，返回 compacted 事件或 null */
  private async doCompaction(config: AgentConfig): Promise<AgentEvent | null> {
    await this.hookRegistry?.emit('pre-compact', { conversationId: config.conversationId })
    const messages = this.conversation.getMutableMessages()
    const result = await this.contextManager.compact(
      messages, this.gateway, config.model, config.provider, config.systemPrompt,
    )
    await this.hookRegistry?.emit('post-compact', { conversationId: config.conversationId })

    if (result.summary) {
      const recentMessages = messages.slice(-result.keptRecentCount)
      this.conversation.replaceWithSummary(result.summaryMessageContent, recentMessages)

      return {
        type: 'agent:compacted',
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        auto: true,
      }
    }
    return null
  }

  // ---- 公共 API ----

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
}
