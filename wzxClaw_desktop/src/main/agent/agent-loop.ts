// ============================================================
// AgentLoop — multi-turn LLM conversation orchestrator
// Responsibilities: loop control + context compaction + event dispatch
// Delegates work to SystemPromptBuilder / TurnManager / StreamPhase
// Message management via ConversationManager
//
// Compaction pipeline (same order as Claude Code):
//   1. Session Memory Compact  — drop oldest API rounds (no API call)
//   2. Microcompact            — clear old tool results (no API call)
//   3. LLM Summary Compact     — full summarization (API call)
//   4. PTL Recovery            — truncate head if compact itself too long
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
import { maybeTimeBasedMicrocompact, maybeTokenPressureMicrocompact } from '../context/microcompact'
import { ToolResultReplacementState } from '../context/tool-result-storage'
import { restoreFiles, formatRestoredFilesMessage } from '../context/compact-file-restore'
import { trySessionMemoryCompact } from '../context/session-memory-compact'
import { runPostCompactCleanup } from '../context/post-compact-cleanup'
import { suppressCompactWarning } from '../context/compact-warning-state'
import { formatPostCompactMessage } from '../context/compact-attachments'
import type { CompactAttachmentContext } from '../context/compact-attachments'

export class AgentLoop {
  private conversation = new ConversationManager()
  private abortController: AbortController | null = null
  private turnManager = new TurnManager()
  private _running: boolean = false

  /** Active workspace context — injected into system prompt when set */
  activeWorkspace: Workspace | null = null

  /** 当前是否正在运行（run() 进入到 finally 退出之间为 true） */
  get isRunning(): boolean {
    return this._running
  }

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
    this._running = true
    try {
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

    // 恢复上次会话的 todos（如有持久化文件）
    const todoTool = this.toolRegistry.get('TodoWrite') as TodoWriteTool | undefined
    if (todoTool && config.conversationId) {
      const saved = await TodoWriteTool.loadForSession(config.conversationId)
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
    // Anthropic provider 用 ToolResultReplacementState 冻结持久化决策，维护 prompt cache 稳定性
    const replacementState = config.provider === 'anthropic' ? new ToolResultReplacementState() : undefined
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
      replacementState,
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
        yield { type: 'agent:error', error: `Safety ceiling reached (${turnCount} turns). This should not happen — the conversation should end naturally.`, recoverable: true, errorCode: 'SAFETY_CEILING' }
        yield { type: 'agent:done', usage: totalUsage, turnCount, model: config.model }
        getActiveTrace(config.conversationId)?.recordErrorCode('SAFETY_CEILING')
        endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
        return
      }

      // 子 Agent 轮数限制检查
      if (maxTurns && turnCount > maxTurns) {
        debugLogger.log('ERROR', `sub-agent max turns reached (${turnCount}/${maxTurns})`)
        debugLogger.close()
        yield { type: 'agent:error', error: `Sub-agent max turns exceeded (${turnCount})`, recoverable: true, errorCode: 'SAFETY_CEILING' }
        yield { type: 'agent:done', usage: totalUsage, turnCount, model: config.model }
        getActiveTrace(config.conversationId)?.recordErrorCode('SAFETY_CEILING')
        endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
        return
      }

      // ==============================================
      // Claude Code compaction pipeline (3-layer)
      // ==============================================

      // Step 1: Session Memory Compact — drop oldest API rounds (no API call)
      const ctxWindow = this.contextManager.getContextWindowForModel(config.model)
      const needsCompact = this.contextManager.shouldCompact(this.conversation.getMutableMessages(), config.model)

      if (needsCompact) {
        const compactThreshold = ctxWindow - this.contextManager.getMaxOutputTokensForModel(config.model) - this.contextManager.getConfig().compactSafetyBuffer
        const smResult = trySessionMemoryCompact(
          this.conversation.getMutableMessages(),
          ctxWindow,
          compactThreshold,
          config.model,
        )
        if (smResult) {
          this.conversation.loadFromExternal(smResult.messages)
          runPostCompactCleanup()
          suppressCompactWarning()
          debugLogger.log('SESSION_MEMORY_COMPACT', `pruned ${smResult.messagesPruned} messages, ${smResult.beforeTokens} -> ${smResult.afterTokens} tokens`)
          if (sender && !sender.isDestroyed()) {
            sender.send(IPC_CHANNELS['session:compacted'], { beforeTokens: smResult.beforeTokens, afterTokens: smResult.afterTokens, auto: true })
          }
          yield { type: 'agent:compacted' as const, beforeTokens: smResult.beforeTokens, afterTokens: smResult.afterTokens, auto: true }
        }
      }

      // Step 2a: Time-based microcompact — clear old tool results (no API call)
      const mcConfig = this.contextManager.getMicrocompactConfig()
      let mcResult = maybeTimeBasedMicrocompact(this.conversation.getMutableMessages(), mcConfig)
      if (mcResult.result.didCompact) {
        this.conversation.loadFromExternal(mcResult.messages)
        debugLogger.log('MICROCOMPACT', `cleared ${mcResult.result.clearedCount} old tool results (~${mcResult.result.charsSaved} chars, gap ${Math.round(mcResult.result.gapMinutes)}min)`)
      }

      // Step 2b: Token-pressure microcompact — more aggressive when context is tight
      if (this.contextManager.shouldCompact(this.conversation.getMutableMessages(), config.model)) {
        const estTokens = this.contextManager.estimateTokens(this.conversation.getMutableMessages(), config.model)
        mcResult = maybeTokenPressureMicrocompact(
          this.conversation.getMutableMessages(),
          ctxWindow,
          estTokens,
          { ...mcConfig, tokenPressureThreshold: this.contextManager.getConfig().microcompactTokenPressureThreshold },
        )
        if (mcResult.result.didCompact) {
          this.conversation.loadFromExternal(mcResult.messages)
          debugLogger.log('MICROCOMPACT_TOKEN_PRESSURE', `cleared ${mcResult.result.clearedCount} old tool results (token pressure)`)
        }
      }

      // Step 3: LLM Summary Compact — full summarization (API call)
      if (this.contextManager.shouldCompact(this.conversation.getMutableMessages(), config.model)) {
        const compacted = await this.doCompaction(config)
        if (compacted) {
          debugLogger.log('COMPACT', 'auto compaction triggered')
          getActiveTrace(config.conversationId)?.evalCollector.recordCompaction()
          yield compacted
          runPostCompactCleanup()
          suppressCompactWarning()
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
            replacementState,
          },
          this.gateway,
          executeTool,
          this.toolRegistry.isReadOnly.bind(this.toolRegistry),
        )
      } catch (streamErr) {
        // 分层错误恢复（参考 Claude Code PTL 分组重试）：
        //   1. Turn-based 逐轮淘汰（从最早的 turn 开始移除，保留最近 2 turns）
        //   2. 降级：移除工具定义，纯对话模式重试（不再调用工具，减少 token）
        //   3. 最终失败
        if (streamErr instanceof PromptTooLongError && reactiveCompactCount < MAX_REACTIVE_COMPACTS) {
          reactiveCompactCount++
          getActiveTrace(config.conversationId)?.evalCollector.recordErrorRecovery('reactive_compact')
          getActiveTrace(config.conversationId)?.evalCollector.recordCompaction()
          const beforeTokens = this.contextManager.estimateTokens(this.conversation.getMutableMessages())
          const compacted = this.contextManager.reactiveCompactByTurns(this.conversation.getMutableMessages())
          this.conversation.loadFromExternal(compacted)
          const afterTokens = this.contextManager.estimateTokens(this.conversation.getMutableMessages())

          debugLogger.log('REACTIVE_COMPACT', `PTL turn-based eviction: ${beforeTokens} -> ${afterTokens} tokens`)

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
          yield { type: 'agent:error', error: 'Context too long — use /compact to reduce context size', recoverable: true, errorCode: 'PROMPT_TOO_LONG' }
          getActiveTrace(config.conversationId)?.recordErrorCode('PROMPT_TOO_LONG')
          endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
          await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
          return
        }
      }

      if (turnResult.hadError) {
        debugLogger.log('ERROR', 'turn had error, stopping')
        debugLogger.close()
        getActiveTrace(config.conversationId)?.recordErrorCode('TURN_ERROR')
        endTrace(config.conversationId, totalUsage, turnCount, true, this.conversation.getMessages())
        await this.hookRegistry?.emit('session-end', { conversationId: config.conversationId })
        return
      }

      // 累计 token 用量
      totalUsage.inputTokens += turnResult.usage.inputTokens
      totalUsage.outputTokens += turnResult.usage.outputTokens

      this.contextManager.trackTokenUsage(turnResult.usage.inputTokens, turnResult.usage.outputTokens)

      // Eval: 记录 turn 输出 token
      getActiveTrace(config.conversationId)?.evalCollector.recordTurn(turnResult.usage.outputTokens, turnResult.usage.inputTokens)

      // Token 预算检查
      if (config.maxBudgetTokens > 0 && totalUsage.inputTokens > config.maxBudgetTokens) {
        debugLogger.log('WARN', `token budget exceeded: ${totalUsage.inputTokens} > ${config.maxBudgetTokens}`)
        yield { type: 'agent:error', error: `Token budget exceeded (${totalUsage.inputTokens.toLocaleString()} / ${config.maxBudgetTokens.toLocaleString()} input tokens)`, recoverable: true, errorCode: 'TOKEN_BUDGET' }
        yield { type: 'agent:done', usage: totalUsage, turnCount, model: config.model }
        getActiveTrace(config.conversationId)?.recordErrorCode('TOKEN_BUDGET')
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
          this.conversation.appendSystemReminder(`<system-reminder>
${hookResult.blockingError}
</system-reminder>`)
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
    } finally {
      this._running = false
    }
  }
  /** Execute LLM summary compaction with post-compact restoration */
  private async doCompaction(config: AgentConfig): Promise<AgentEvent | null> {
    await this.hookRegistry?.emit('pre-compact', { conversationId: config.conversationId })
    const messages = this.conversation.getMutableMessages()
    const result = await this.contextManager.compact(
      messages, this.gateway, config.model, config.provider, config.systemPrompt
    )
    await this.hookRegistry?.emit('post-compact', { conversationId: config.conversationId })

    if (result.summary) {
      const recentMessages = messages.slice(-result.keptRecentCount)
      this.conversation.replaceWithSummary(result.summaryMessageContent, recentMessages)

      // Post-compact attachment restoration (Claude Code style)
      const attachmentCtx: CompactAttachmentContext = {
        todos: [],
        restoredFiles: [],
        workingDirectory: config.workingDirectory || this.activeWorkspace?.projects?.[0]?.path,
      }

      // 1. Restore recently referenced files
      if (result.summarizedMessages.length > 0) {
        const restored = await restoreFiles(result.summarizedMessages, attachmentCtx.workingDirectory)
        attachmentCtx.restoredFiles = restored
      }

      // 2. Restore todo list
      const todoTool = this.toolRegistry.get('TodoWrite') as TodoWriteTool | undefined
      if (todoTool) {
        attachmentCtx.todos = todoTool.getCurrentTodos()
      }

      // 3. Build and inject post-compact message (todos + files + instructions)
      const postCompactMsg = formatPostCompactMessage(attachmentCtx)
      if (postCompactMsg) {
        this.conversation.getMutableMessages().push(postCompactMsg)
      }

      // 4. Inject restored files as separate system-reminder if any
      if (attachmentCtx.restoredFiles.length > 0) {
        const filesMsg: Message = {
          role: 'user',
          content: formatRestoredFilesMessage(attachmentCtx.restoredFiles),
          timestamp: Date.now(),
        }
        this.conversation.getMutableMessages().push(filesMsg)
      }

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
    this._running = false
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
        this.conversation.replaceWithSummary(result.summaryMessageContent, recentMessages)
        const afterTokens = this.contextManager.estimateTokens(this.conversation.getMutableMessages())
        return { messageCount: this.conversation.length, compacted: true, beforeTokens, afterTokens }
      }
    }

    this.conversation.loadFromExternal(messages)
    return { messageCount: messages.length, compacted: false, beforeTokens, afterTokens: beforeTokens }
  }
}
