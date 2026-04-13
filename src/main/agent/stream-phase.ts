// ============================================================
// StreamPhase — LLM 流消费 + 工具调度
// 从 AgentLoop.run() 的流处理循环中提取
// ============================================================

import type { StreamEvent, ToolCall, ContentBlock, TokenUsage } from '../../shared/types'
import type { StreamOptions } from '../llm/types'
import type { AgentEvent, AgentConfig } from './types'
import type { ToolExecResult } from './streaming-tool-executor'
import { StreamingToolExecutor } from './streaming-tool-executor'
import { PromptTooLongError } from '../llm/retry'

/**
 * 流阶段的结果
 */
export interface StreamPhaseResult {
  /** LLM 输出的文本内容 */
  textContent: string
  /** 本轮所有工具调用 */
  toolCalls: ToolCall[]
  /** 交错内容块（保留 text/tool_use 原始顺序） */
  contentBlocks: ContentBlock[]
  /** 本轮 token 用量 */
  usage: TokenUsage
  /** 是否遇到不可恢复的错误 */
  hadError: boolean
  /** 是否检测到循环（需要终止 agent loop） */
  loopDetected: boolean
  /** 工具执行结果（按 LLM 发射顺序） */
  toolResults: ToolExecResult[]
  /** 流阶段产生的事件（yield 给消费者） */
  events: AgentEvent[]
}

/**
 * 工具执行核心函数的类型
 * 由 AgentLoop 提供，封装了 loop 检测、权限检查、工具执行等
 */
export type ExecuteToolFn = (toolCall: ToolCall) => Promise<ToolExecResult>

/**
 * LLM 网关的 stream 方法签名
 */
export type StreamFn = (options: StreamOptions) => AsyncGenerator<StreamEvent>

/**
 * 执行一轮完整的流阶段：
 * 1. 调用 LLM 流
 * 2. 消费流事件（文本增量、工具调用开始/结束）
 * 3. 在流中即时启动工具执行（StreamingToolExecutor）
 * 4. 等待所有工具完成
 *
 * @param streamFn    LLM 网关的 stream 方法
 * @param streamOpts  传给 stream 的选项
 * @param isReadOnly  判断工具是否只读（用于并发调度）
 * @param executeTool 工具执行函数（由调用方提供，含权限检查等）
 */
export async function executeStreamPhase(
  streamFn: StreamFn,
  streamOpts: StreamOptions,
  isReadOnly: (toolName: string) => boolean,
  executeTool: ExecuteToolFn,
): Promise<StreamPhaseResult> {
  let textContent = ''
  const toolCalls: ToolCall[] = []
  const contentBlocks: ContentBlock[] = []
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let hadError = false
  const events: AgentEvent[] = []

  // 工具名映射：tool_use_start 记录 id→name，tool_use_end 时取出
  const toolNameMap = new Map<string, string>()

  // 流式工具执行器：只读工具立即并行，写入工具串行
  const executor = new StreamingToolExecutor(isReadOnly)

  try {
    for await (const event of streamFn(streamOpts)) {
      switch (event.type) {
        case 'text_delta': {
          textContent += event.content
          // 追加到当前文本块或创建新块
          if (contentBlocks.length > 0 && contentBlocks[contentBlocks.length - 1].type === 'text') {
            ;(contentBlocks[contentBlocks.length - 1] as { type: 'text'; text: string }).text += event.content
          } else {
            contentBlocks.push({ type: 'text', text: event.content })
          }
          events.push({ type: 'agent:text', content: event.content })
          break
        }

        case 'tool_use_start': {
          toolNameMap.set(event.id, event.name)
          break
        }

        case 'tool_use_end': {
          const toolName = toolNameMap.get(event.id) || ''
          const toolCall: ToolCall = { id: event.id, name: toolName, input: event.parsedInput }
          toolCalls.push(toolCall)
          contentBlocks.push({ type: 'tool_use', id: event.id, name: toolName, input: event.parsedInput })
          // 即时通知 UI
          events.push({ type: 'agent:tool_call', toolCallId: event.id, toolName, input: event.parsedInput })
          // 立即启动工具执行
          executor.onToolUseEnd(event.id, toolName, () => executeTool(toolCall))
          break
        }

        case 'error': {
          events.push({ type: 'agent:error', error: event.error, recoverable: false })
          hadError = true
          break
        }

        case 'done': {
          usage = event.usage
          break
        }
      }

      if (hadError) break
    }
  } catch (streamErr) {
    // PromptTooLongError 需要特殊处理，重新抛出让调用方处理
    if (streamErr instanceof PromptTooLongError) {
      throw streamErr
    }
    // 其他流错误
    events.push({
      type: 'agent:error',
      error: streamErr instanceof Error ? streamErr.message : String(streamErr),
      recoverable: false,
    })
    hadError = true
  }

  // 等待所有工具执行完成（无论是否出错都必须 await，防止后台悬空任务）
  let loopDetected = false
  const toolResults: ToolExecResult[] = []

  if (executor.size > 0) {
    const execResults = await executor.waitAll()

    // 出错时丢弃结果（防止静默的后台文件修改），但必须等待完成（上方已 await）
    if (!hadError) {
      for (const result of execResults) {
        toolResults.push(result)
        if (result.loopDetected) {
          events.push({
            type: 'agent:error',
            error: 'Loop detected: same tool call repeated 3+ times',
            recoverable: true,
          })
          loopDetected = true
          // 继续循环，为后续工具也发出 tool_result 事件（防止 UI 泡泡永远"运行中"）
          continue
        }
        events.push({
          type: 'agent:tool_result',
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          output: result.output,
          isError: result.isError,
        })
      }
    }
  }

  return {
    textContent,
    toolCalls,
    contentBlocks,
    usage,
    hadError,
    loopDetected,
    toolResults,
    events,
  }
}
