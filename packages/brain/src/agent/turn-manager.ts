// ============================================================
// TurnManager — 单轮 agent turn 生命周期管理（DI 版本）
// 零 Electron 依赖：无 createExecuteToolFn，工具执行通过外部注入
//
// v2: executeTurn 为 async generator，事件逐条 yield
// ============================================================

import type { Message, ToolCall, LLMProvider, ContentBlock } from '../types.js'
import type { StreamOptions } from '../llm/types.js'
import type { AgentEvent, AgentConfig } from './types.js'
import type { ToolExecResult } from './streaming-tool-executor.js'
import type { IStreamProvider, IObservability } from '../interfaces.js'
import { LoopDetector } from './loop-detector.js'
import { MessageBuilder } from './message-builder.js'
import { FileChangeTracker, buildTurnAttachments } from '../context/turn-attachments.js'
import { executeStreamPhase, type StreamPhaseMeta, type ExecuteToolFn, type StreamFn } from './stream-phase.js'
import { ConversationManager } from './conversation-manager.js'
import { ToolResultReplacementState } from '../context/tool-result-storage.js'
import path from 'path'

/**
 * 单轮 turn 的输入参数（纯数据，无 Electron 类型）
 */
export interface TurnInput {
  /** 当前 turn 编号（0-based） */
  turnIndex: number
  /** 对话管理器 */
  conversation: ConversationManager
  /** Agent 配置 */
  config: AgentConfig
  /** 系统提示（已构建完成） */
  systemPrompt: string
  /** 工具定义 */
  toolDefinitions: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
  /** AbortSignal */
  abortSignal: AbortSignal
  /** 工具结果替换决策冻结状态 */
  replacementState?: ToolResultReplacementState
}

/**
 * 单轮 turn 的输出结果
 */
export interface TurnResult {
  /** 是否应该终止 agent loop */
  shouldStop: boolean
  /** 本轮 token 用量 */
  usage: { inputTokens: number; outputTokens: number }
  /** 是否有不可恢复错误 */
  hadError: boolean
  /** 本轮调用的工具名列表 */
  toolNames: string[]
}

/**
 * TurnManager 管理单轮 turn 的执行。
 *
 * 职责：
 * - turn attachment 注入（非首轮）
 * - 构建 provider 消息 + stream options
 * - 调用 StreamPhase 执行 LLM 流 + 工具调度
 * - 通过 ConversationManager 记录消息
 * - 文件变更追踪
 */
export class TurnManager {
  private loopDetector = new LoopDetector()
  private fileTracker = new FileChangeTracker()
  private messageBuilder = new MessageBuilder()

  /**
   * 执行一轮 turn（async generator 版本）
   *
   * @param input - turn 输入（纯数据）
   * @param gateway - LLM 流提供者
   * @param executeTool - 外部注入的工具执行函数
   * @param isReadOnly - 判断工具是否只读
   */
  async *executeTurn(
    input: TurnInput,
    gateway: IStreamProvider,
    executeTool: ExecuteToolFn,
    isReadOnly: (toolName: string) => boolean,
  ): AsyncGenerator<AgentEvent, TurnResult> {
    this.fileTracker.advanceTurn()

    // 1. 检查取消
    if (input.abortSignal.aborted) {
      yield { type: 'agent:error', error: 'Agent loop cancelled', recoverable: true }
      return { shouldStop: true, usage: { inputTokens: 0, outputTokens: 0 }, hadError: true, toolNames: [] }
    }

    // 2. 非首轮注入 turn attachments
    if (input.turnIndex > 0) {
      const attachmentText = buildTurnAttachments({
        ...this.fileTracker.getContext(),
        activeWorkspaces: undefined,
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

    // 5. 执行流阶段
    const streamFn: StreamFn = async function* (opts) {
      for await (const event of gateway.stream(opts)) {
        yield event
      }
    }

    let phaseMeta: StreamPhaseMeta
    try {
      phaseMeta = yield* executeStreamPhase(streamFn, streamOpts, isReadOnly, executeTool)
    } catch (err) {
      throw err
    }

    if (phaseMeta.hadError) {
      return { shouldStop: true, usage: phaseMeta.usage, hadError: true, toolNames: phaseMeta.toolCalls.map(tc => tc.name) }
    }

    // 6. 通过 ConversationManager 记录 assistant 消息
    input.conversation.appendAssistantMessage(
      phaseMeta.textContent,
      phaseMeta.toolCalls,
      phaseMeta.contentBlocks.length > 0 ? phaseMeta.contentBlocks : undefined,
    )

    // 7. 无工具调用 → 结束
    if (phaseMeta.toolCalls.length === 0) {
      return { shouldStop: true, usage: phaseMeta.usage, hadError: false, toolNames: [] }
    }

    // 8. 处理工具结果
    if (phaseMeta.loopDetected) {
      return { shouldStop: true, usage: phaseMeta.usage, hadError: false, toolNames: phaseMeta.toolCalls.map(tc => tc.name) }
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
      } else if ((result.toolName === 'FileWrite' || result.toolName === 'FileEdit' || result.toolName === 'MultiEdit') && !result.isError) {
        const tc = phaseMeta.toolCalls.find(t => t.id === result.toolCallId)
        const rawPath = result.toolName === 'MultiEdit'
          ? String(tc?.input?.file_path ?? '')
          : String(tc?.input?.path ?? '')
        if (rawPath) {
          const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(input.config.workingDirectory, rawPath)
          this.fileTracker.recordWrite(absPath)
        }
      }

      // 通过 ConversationManager 追加 tool_result 消息
      let finalContent: string
      const cached = input.replacementState?.getCachedDecision(result.toolCallId)
      if (cached !== undefined) {
        finalContent = cached ?? result.truncatedOutput
      } else {
        // Brain 包不做磁盘持久化 — 直接使用截断输出
        finalContent = result.truncatedOutput
        input.replacementState?.recordDecision(result.toolCallId, null)
      }
      input.conversation.appendToolResult(
        result.toolCallId,
        finalContent,
        result.isError,
      )
    }

    // 9. turn_end 事件
    yield { type: 'agent:turn_end' as const }

    return { shouldStop: false, usage: phaseMeta.usage, hadError: false, toolNames: phaseMeta.toolCalls.map(tc => tc.name) }
  }

  /** 重置所有状态 */
  reset(): void {
    this.loopDetector.reset()
    this.fileTracker.reset()
  }
}
