// ============================================================
// TurnManager — 封装单轮 agent turn 的完整生命周期
// 从 AgentLoop.run() 的 for 循环体中提取
// 消息操作通过 ConversationManager 进行
//
// v2: executeTurn 为 async generator，事件逐条 yield
// ============================================================

import type { Message, ToolCall, LLMProvider, ContentBlock } from '../../shared/types'
import type { StreamOptions } from '../llm/types'
import type { AgentEvent, AgentConfig } from './types'
import type { ToolExecResult } from './streaming-tool-executor'
import type { ToolRegistry } from '../tools/tool-registry'
import type { PermissionManager } from '../permission/permission-manager'
import type { ContextManager } from '../context/context-manager'
import type { HookRegistry } from '../hooks/hook-registry'
import type { FileHistoryManager } from '../file-history/file-history-manager'
import type { LLMGateway } from '../llm/gateway'
import { LoopDetector } from './loop-detector'
import { MessageBuilder } from './message-builder'
import { FileChangeTracker, buildTurnAttachments } from '../context/turn-attachments'
import { truncateToolResult, enforceContextBudget, ToolResultEntry } from '../context/tool-result-budget'
import { ContextManager as ContextManagerClass } from '../context/context-manager'
import { executeStreamPhase, type StreamPhaseMeta, type ExecuteToolFn, type StreamFn } from './stream-phase'
import { ConversationManager } from './conversation-manager'
import { flattenToolOutput } from '../tools/tool-interface'
import path from 'path'
import { getActiveTrace, type AgentTraceContext } from '../observability/langfuse-observer'

/**
 * 单轮 turn 的输入参数
 */
export interface TurnInput {
  /** 当前 turn 编号（0-based） */
  turnIndex: number
  /** 对话管理器（统一管理消息操作） */
  conversation: ConversationManager
  /** Agent 配置 */
  config: AgentConfig
  /** 系统提示（已构建完成） */
  systemPrompt: string
  /** 工具定义 */
  toolDefinitions: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
  /** AbortSignal */
  abortSignal: AbortSignal
  /** Electron WebContents（用于权限请求） */
  sender?: Electron.WebContents
}

/**
 * 单轮 turn 的输出结果（不含 events — 已通过 yield 传递）
 */
export interface TurnResult {
  /** 是否应该终止 agent loop（无工具调用 or 错误） */
  shouldStop: boolean
  /** 本轮 token 用量 */
  usage: { inputTokens: number; outputTokens: number }
  /** 是否有不可恢复错误 */
  hadError: boolean
}

/**
 * TurnManager 管理单轮 turn 的执行。
 *
 * 职责：
 * - turn attachment 注入（非首轮）
 * - 构建 provider 消息 + stream options
 * - 调用 StreamPhase 执行 LLM 流 + 工具调度（yield* 委托）
 * - 通过 ConversationManager 记录 assistant 和 tool_result 消息
 * - 文件变更追踪
 * - 全局工具结果预算裁剪
 */
export class TurnManager {
  private loopDetector = new LoopDetector()
  private fileTracker = new FileChangeTracker()
  private messageBuilder = new MessageBuilder()

  /** 创建工具执行核心函数，闭包捕获依赖 */
  createExecuteToolFn(
    toolRegistry: ToolRegistry,
    permissionManager: PermissionManager,
    contextManager: ContextManager,
    hookRegistry: HookRegistry | undefined,
    historyManager: FileHistoryManager | undefined,
    config: AgentConfig,
    abortSignal: AbortSignal,
    sender?: Electron.WebContents,
    taskId?: string,
  ): ExecuteToolFn {
    return async (toolCall: ToolCall): Promise<ToolExecResult> => {
      const _eval = getActiveTrace(config.conversationId)?.evalCollector

      // 1. 循环检测
      this.loopDetector.record(toolCall.name, toolCall.input)
      if (this.loopDetector.isLooping()) {
        const msg = 'Loop detected: same tool call repeated 3+ times'
        _eval?.recordToolCall(toolCall.name, true, true)
        return { toolCallId: toolCall.id, toolName: toolCall.name, output: msg, truncatedOutput: msg, isError: true, loopDetected: true }
      }

      // 2. 工具查找
      const tool = toolRegistry.get(toolCall.name)
      if (!tool) {
        const msg = ContextManagerClass.truncateToolResult(`Tool not found: ${toolCall.name}`)
        _eval?.recordToolCall(toolCall.name, true, false)
        return { toolCallId: toolCall.id, toolName: toolCall.name, output: msg, truncatedOutput: msg, isError: true, loopDetected: false }
      }

      // 3. Plan mode 检查
      const planModeRejection = permissionManager.getPlanModeRejection(toolCall.name)
      if (planModeRejection) {
        const truncated = ContextManagerClass.truncateToolResult(planModeRejection)
        _eval?.recordToolCall(toolCall.name, true, false)
        return { toolCallId: toolCall.id, toolName: toolCall.name, output: planModeRejection, truncatedOutput: truncated, isError: true, loopDetected: false }
      }

      // 4. 权限审批
      if (permissionManager.needsApproval(toolCall.name, toolCall.input)) {
        let approved = false
        if (sender) {
          approved = await permissionManager.requestApproval(config.conversationId, toolCall.name, toolCall.input, sender)
        }
        if (!approved) {
          await hookRegistry?.emit('permission-denied', { toolName: toolCall.name, toolInput: toolCall.input, conversationId: config.conversationId })
          const msg = `Permission denied for tool: ${toolCall.name}`
          _eval?.recordToolCall(toolCall.name, true, false)
          return { toolCallId: toolCall.id, toolName: toolCall.name, output: msg, truncatedOutput: msg, isError: true, loopDetected: false }
        }
      }

      // 5. 执行工具
      try {
        await hookRegistry?.emit('pre-tool', { toolName: toolCall.name, toolInput: toolCall.input, conversationId: config.conversationId })

        // 文件快照（写入前）
        if (historyManager && (toolCall.name === 'FileWrite' || toolCall.name === 'FileEdit')) {
          const rawPath = String(toolCall.input.path ?? '')
          if (rawPath) {
            const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(config.workingDirectory, rawPath)
            await historyManager.snapshot(absolutePath, toolCall.id)
          }
        }

        const toolSpan = getActiveTrace(config.conversationId)?.startToolSpan(toolCall.name, toolCall.input)
        const result = await tool.execute(toolCall.input, {
          workingDirectory: config.workingDirectory,
          taskId,
          abortSignal,
        })

        // 展平输出：string 直接用，ToolResultContent[] 拼接文本
        const flatOutput = flattenToolOutput(result.output)
        const truncatedOutput = truncateToolResult(toolCall.name, flatOutput)
        toolSpan?.end({ output: truncatedOutput.slice(0, 1000), level: result.isError ? 'ERROR' : 'DEFAULT' })

        await hookRegistry?.emit('post-tool', {
          toolName: toolCall.name,
          toolInput: toolCall.input,
          toolOutput: truncatedOutput,
          isError: result.isError,
          conversationId: config.conversationId,
        })

        _eval?.recordToolCall(toolCall.name, result.isError, false)
        return { toolCallId: toolCall.id, toolName: toolCall.name, output: flatOutput, truncatedOutput, isError: result.isError, loopDetected: false }
      } catch (err) {
        const msg = ContextManagerClass.truncateToolResult(err instanceof Error ? err.message : String(err))
        _eval?.recordToolCall(toolCall.name, true, false)
        return { toolCallId: toolCall.id, toolName: toolCall.name, output: msg, truncatedOutput: msg, isError: true, loopDetected: false }
      }
    }
  }

  /**
   * 执行一轮 turn（async generator 版本）
   * 事件通过 yield 逐条传递，元数据通过 return 返回
   */
  async *executeTurn(
    input: TurnInput,
    gateway: LLMGateway,
    executeTool: ExecuteToolFn,
    isReadOnly: (toolName: string) => boolean,
  ): AsyncGenerator<AgentEvent, TurnResult> {
    this.fileTracker.advanceTurn()

    // 1. 检查取消
    if (input.abortSignal.aborted) {
      yield { type: 'agent:error', error: 'Agent loop cancelled', recoverable: true }
      return { shouldStop: true, usage: { inputTokens: 0, outputTokens: 0 }, hadError: true }
    }

    // 2. 非首轮注入 turn attachments
    if (input.turnIndex > 0) {
      const attachmentText = buildTurnAttachments({
        ...this.fileTracker.getContext(),
        activeTasks: undefined,
      })
      if (attachmentText) {
        input.conversation.appendSystemReminder(attachmentText)
      }
    }

    // 3. 构建 provider 消息
    const messages = input.conversation.getMutableMessages()
    const providerMessages = this.messageBuilder.buildMessages(messages, input.config.provider)

    // 4. 构建 stream options
    const streamOpts: StreamOptions = {
      model: input.config.model,
      messages: providerMessages,
      systemPrompt: input.systemPrompt,
      tools: input.toolDefinitions,
      abortSignal: input.abortSignal,
      thinkingDepth: input.config.thinkingDepth,
    }

    // 5. 执行流阶段（wrapped with Langfuse generation tracking）
    const traceCtx = getActiveTrace(input.config.conversationId)
    let _generation: ReturnType<AgentTraceContext['startGeneration']> | undefined
    let _capturedUsage: { input: number; output: number } | undefined

    const trackedStream: StreamFn = async function* (opts) {
      if (traceCtx) {
        _generation = traceCtx.startGeneration(input.turnIndex, opts.model, opts.messages)
      }
      for await (const event of gateway.stream(opts)) {
        if (event.type === 'done') {
          _capturedUsage = { input: event.usage.inputTokens, output: event.usage.outputTokens }
        }
        yield event
      }
    }

    let phaseMeta: StreamPhaseMeta
    try {
      phaseMeta = yield* executeStreamPhase(trackedStream, streamOpts, isReadOnly, executeTool)
      _generation?.end({
        output: phaseMeta.textContent || undefined,
        usage: _capturedUsage,
        level: phaseMeta.hadError ? 'ERROR' : 'DEFAULT',
      })
    } catch (err) {
      _generation?.end({ level: 'ERROR', statusMessage: err instanceof Error ? err.message : String(err) })
      throw err
    }

    if (phaseMeta.hadError) {
      return { shouldStop: true, usage: phaseMeta.usage, hadError: true }
    }

    // 6. 通过 ConversationManager 记录 assistant 消息
    input.conversation.appendAssistantMessage(
      phaseMeta.textContent,
      phaseMeta.toolCalls,
      phaseMeta.contentBlocks.length > 0 ? phaseMeta.contentBlocks : undefined,
    )

    // 7. 无工具调用 → 结束
    if (phaseMeta.toolCalls.length === 0) {
      return { shouldStop: true, usage: phaseMeta.usage, hadError: false }
    }

    // 8. 处理工具结果
    if (phaseMeta.loopDetected) {
      return { shouldStop: true, usage: phaseMeta.usage, hadError: false }
    }

    for (const result of phaseMeta.toolResults) {
      // 文件变更追踪
      if (result.toolName === 'FileRead' && !result.isError) {
        const tc = phaseMeta.toolCalls.find(t => t.id === result.toolCallId)
        if (tc?.input?.path) {
          const rawPath = String(tc.input.path)
          const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(input.config.workingDirectory, rawPath)
          this.fileTracker.recordRead(absPath)
        }
      } else if ((result.toolName === 'FileWrite' || result.toolName === 'FileEdit') && !result.isError) {
        const tc = phaseMeta.toolCalls.find(t => t.id === result.toolCallId)
        if (tc?.input?.path) {
          const rawPath = String(tc.input.path)
          const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(input.config.workingDirectory, rawPath)
          this.fileTracker.recordWrite(absPath)
        }
      }

      // 通过 ConversationManager 追加 tool_result 消息
      input.conversation.appendToolResult(
        result.toolCallId,
        result.truncatedOutput,
        result.isError,
      )
    }

    // 9. 全局工具结果预算裁剪
    const toolResultEntries = input.conversation.getToolResultEntries()
    const budgeted = enforceContextBudget(
      toolResultEntries.map(e => ({
        toolName: 'tool_result',
        result: e.content,
        turnIndex: e.index,
      }))
    )
    for (const entry of budgeted) {
      input.conversation.updateToolResultContent(entry.turnIndex, entry.result)
    }

    // 10. turn_end 事件
    yield { type: 'agent:turn_end' as const }

    return { shouldStop: false, usage: phaseMeta.usage, hadError: false }
  }

  /** 重置所有状态 */
  reset(): void {
    this.loopDetector.reset()
    this.fileTracker.reset()
  }
}
