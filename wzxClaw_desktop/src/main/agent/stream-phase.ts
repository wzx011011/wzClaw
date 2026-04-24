// ============================================================
// StreamPhase — LLM 流消费 + 工具调度
// 从 AgentLoop.run() 的流处理循环中提取
//
// v2: async generator — 事件逐条 yield 而非批量收集到数组
// ============================================================

import type { StreamEvent, ToolCall, ContentBlock, TokenUsage } from '../../shared/types'
import type { StreamOptions } from '../llm/types'
import type { AgentEvent } from './types'
import type { ToolExecResult } from './streaming-tool-executor'
import { StreamingToolExecutor } from './streaming-tool-executor'
import { PromptTooLongError } from '../llm/retry'

/**
 * 流阶段的元数据（不含 events 数组，事件已通过 yield 逐条传递）
 */
export interface StreamPhaseMeta {
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
 * 执行一轮完整的流阶段（async generator 版本）：
 * 1. 调用 LLM 流
 * 2. 逐条 yield 文本增量和工具调用事件
 * 3. 在流中即时启动工具执行（StreamingToolExecutor）
 * 4. 逐条 yield 工具执行结果
 * 5. 返回元数据
 *
 * @param streamFn    LLM 网关的 stream 方法
 * @param streamOpts  传给 stream 的选项
 * @param isReadOnly  判断工具是否只读（用于并发调度）
 * @param executeTool 工具执行函数（由调用方提供，含权限检查等）
 */
export async function* executeStreamPhase(
  streamFn: StreamFn,
  streamOpts: StreamOptions,
  isReadOnly: (toolName: string) => boolean,
  executeTool: ExecuteToolFn,
): AsyncGenerator<AgentEvent, StreamPhaseMeta> {
  let textContent = ''
  const toolCalls: ToolCall[] = []
  const contentBlocks: ContentBlock[] = []
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let hadError = false

  // 工具名映射：tool_use_start 记录 id→name，tool_use_end 时取出
  const toolNameMap = new Map<string, string>()

  // 流式工具执行器：只读工具立即并行，写入工具串行
  const executor = new StreamingToolExecutor(isReadOnly)

  // ---- Phase 1: LLM 流 — 逐条 yield 事件 ----
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
          yield { type: 'agent:text', content: event.content }
          break
        }

        case 'thinking_delta': {
          yield { type: 'agent:thinking', content: event.content }
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
          yield { type: 'agent:tool_call', toolCallId: event.id, toolName, input: event.parsedInput }
          // 立即启动工具执行
          executor.onToolUseEnd(event.id, toolName, () => executeTool(toolCall))
          break
        }

        case 'error': {
          yield { type: 'agent:error', error: event.error, recoverable: false }
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
    yield {
      type: 'agent:error',
      error: streamErr instanceof Error ? streamErr.message : String(streamErr),
      recoverable: false,
    }
    hadError = true
  }

  // ---- Phase 2: 工具结果 — 逐条 yield ----
  let loopDetected = false
  const toolResults: ToolExecResult[] = []

  if (executor.size > 0) {
    // 逐个 await + yield，而非 waitAll() 批量等待
    for (const pending of executor.getPending()) {
      let result: ToolExecResult
      try {
        result = await pending.promise
      } catch (err) {
        result = {
          toolCallId: pending.id,
          toolName: pending.name,
          output: err instanceof Error ? err.message : String(err),
          truncatedOutput: err instanceof Error ? err.message : String(err),
          isError: true,
          loopDetected: false,
        }
      }

      // 出错时 yield 错误结果（让 UI 工具卡片退出 running 状态）
      if (hadError) {
        yield {
          type: 'agent:tool_result',
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          output: result.output,
          isError: true,
        }
        continue
      }

      toolResults.push(result)
      if (result.loopDetected) {
        yield {
          type: 'agent:error',
          error: 'Loop detected: same tool call repeated 3+ times',
          recoverable: true,
        }
        loopDetected = true
        continue
      }
      yield {
        type: 'agent:tool_result',
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        output: result.output,
        isError: result.isError,
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
  }
}
