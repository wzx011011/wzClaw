// ============================================================
// TurnManager — 封装单轮 agent turn 的完整生命周期
// 从 AgentLoop.run() 的 for 循环体中提取
// 消息操作通过 ConversationManager 进行
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
import { executeStreamPhase, type ExecuteToolFn } from './stream-phase'
import { ConversationManager } from './conversation-manager'
import { flattenToolOutput } from '../tools/tool-interface'
import path from 'path'

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
 * 单轮 turn 的输出结果
 */
export interface TurnResult {
  /** 本轮产生的事件（yield 给消费者） */
  events: AgentEvent[]
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
 * - 调用 StreamPhase 执行 LLM 流 + 工具调度
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
  ): ExecuteToolFn {
    return async (toolCall: ToolCall): Promise<ToolExecResult> => {
      // 1. 循环检测
      this.loopDetector.record(toolCall.name, toolCall.input)
      if (this.loopDetector.isLooping()) {
        const msg = 'Loop detected: same tool call repeated 3+ times'
        return { toolCallId: toolCall.id, toolName: toolCall.name, output: msg, truncatedOutput: msg, isError: true, loopDetected: true }
      }

      // 2. 工具查找
      const tool = toolRegistry.get(toolCall.name)
      if (!tool) {
        const msg = ContextManagerClass.truncateToolResult(`Tool not found: ${toolCall.name}`)
        return { toolCallId: toolCall.id, toolName: toolCall.name, output: msg, truncatedOutput: msg, isError: true, loopDetected: false }
      }

      // 3. Plan mode 检查
      const planModeRejection = permissionManager.getPlanModeRejection(toolCall.name)
      if (planModeRejection) {
        const truncated = ContextManagerClass.truncateToolResult(planModeRejection)
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

        const result = await tool.execute(toolCall.input, {
          workingDirectory: config.workingDirectory,
          abortSignal,
        })

        // 展平输出：string 直接用，ToolResultContent[] 拼接文本
        const flatOutput = flattenToolOutput(result.output)
        const truncatedOutput = truncateToolResult(toolCall.name, flatOutput)

        await hookRegistry?.emit('post-tool', {
          toolName: toolCall.name,
          toolInput: toolCall.input,
          toolOutput: truncatedOutput,
          isError: result.isError,
          conversationId: config.conversationId,
        })

        return { toolCallId: toolCall.id, toolName: toolCall.name, output: flatOutput, truncatedOutput, isError: result.isError, loopDetected: false }
      } catch (err) {
        const msg = ContextManagerClass.truncateToolResult(err instanceof Error ? err.message : String(err))
        return { toolCallId: toolCall.id, toolName: toolCall.name, output: msg, truncatedOutput: msg, isError: true, loopDetected: false }
      }
    }
  }

  /**
   * 执行一轮 turn
   */
  async executeTurn(
    input: TurnInput,
    gateway: LLMGateway,
    executeTool: ExecuteToolFn,
    isReadOnly: (toolName: string) => boolean,
  ): Promise<TurnResult> {
    const events: AgentEvent[] = []
    this.fileTracker.advanceTurn()

    // 1. 检查取消
    if (input.abortSignal.aborted) {
      events.push({ type: 'agent:error', error: 'Agent loop cancelled', recoverable: true })
      return { events, shouldStop: true, usage: { inputTokens: 0, outputTokens: 0 }, hadError: true }
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
    }

    // 5. 执行流阶段
    const phaseResult = await executeStreamPhase(
      gateway.stream.bind(gateway),
      streamOpts,
      isReadOnly,
      executeTool,
    )

    // 收集流阶段事件
    events.push(...phaseResult.events)

    if (phaseResult.hadError) {
      return { events, shouldStop: true, usage: phaseResult.usage, hadError: true }
    }

    // 6. 通过 ConversationManager 记录 assistant 消息
    input.conversation.appendAssistantMessage(
      phaseResult.textContent,
      phaseResult.toolCalls,
      phaseResult.contentBlocks.length > 0 ? phaseResult.contentBlocks : undefined,
    )

    // 7. 无工具调用 → 结束
    if (phaseResult.toolCalls.length === 0) {
      return { events, shouldStop: true, usage: phaseResult.usage, hadError: false }
    }

    // 8. 处理工具结果
    if (phaseResult.loopDetected) {
      return { events, shouldStop: true, usage: phaseResult.usage, hadError: false }
    }

    for (const result of phaseResult.toolResults) {
      // 文件变更追踪
      if (result.toolName === 'FileRead' && !result.isError) {
        const tc = phaseResult.toolCalls.find(t => t.id === result.toolCallId)
        if (tc?.input?.path) {
          const rawPath = String(tc.input.path)
          const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(input.config.workingDirectory, rawPath)
          this.fileTracker.recordRead(absPath)
        }
      } else if ((result.toolName === 'FileWrite' || result.toolName === 'FileEdit') && !result.isError) {
        const tc = phaseResult.toolCalls.find(t => t.id === result.toolCallId)
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
    events.push({ type: 'agent:turn_end' as const })

    return { events, shouldStop: false, usage: phaseResult.usage, hadError: false }
  }

  /** 重置所有状态 */
  reset(): void {
    this.loopDetector.reset()
    this.fileTracker.reset()
  }
}
