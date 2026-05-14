// ============================================================
// StreamPhase — LLM 流消费 + 工具调度（DI 版本）
// 零 Electron 依赖：所有类型从 brain 包内部导入
//
// v2: async generator — 事件逐条 yield 而非批量收集到数组
// ============================================================

import type { StreamEvent, ToolCall, ContentBlock, TokenUsage } from '../types.js'
import type { StreamOptions } from '../llm/types.js'
import type { AgentEvent } from './types.js'
import type { ToolExecResult } from './streaming-tool-executor.js'
import { StreamingToolExecutor } from './streaming-tool-executor.js'
import { PromptTooLongError } from '../llm/retry.js'

/**
 * 流阶段的元数据
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
  /** 错误信息（hadError 时有值） */
  errorMessage?: string
  /** 是否检测到循环 */
  loopDetected: boolean
  /** 工具执行结果 */
  toolResults: ToolExecResult[]
}

/**
 * 工具执行核心函数的类型
 * 由外部注入，封装了 loop 检测、权限检查、工具执行等
 */
export type ExecuteToolFn = (toolCall: ToolCall) => Promise<ToolExecResult>

/**
 * LLM 流函数签名
 */
export type StreamFn = (options: StreamOptions) => AsyncGenerator<StreamEvent>

/**
 * 执行一轮完整的流阶段（async generator 版本）：
 * 1. 调用 LLM 流
 * 2. 逐条 yield 文本增量和工具调用事件
 * 3. 在流中即时启动工具执行
 * 4. 逐条 yield 工具执行结果
 * 5. 返回元数据
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
  let errorMessage: string | undefined

  const toolNameMap = new Map<string, string>()
  const executor = new StreamingToolExecutor(isReadOnly)

  // 看门狗超时
  const FIRST_EVENT_TIMEOUT_MS = 180_000
  const INTER_EVENT_TIMEOUT_MS = 90_000
  let eventTimer: ReturnType<typeof setTimeout> | null = null
  let watchdogTriggered = false
  let firstEventReceived = false

  const watchdogController = new AbortController()
  const signals: AbortSignal[] = [watchdogController.signal]
  if (streamOpts.abortSignal) signals.push(streamOpts.abortSignal)
  const combinedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
  const streamOptsWithWatchdog = { ...streamOpts, abortSignal: combinedSignal }

  const resetWatchdog = (timeoutMs: number) => {
    if (eventTimer) clearTimeout(eventTimer)
    eventTimer = setTimeout(() => {
      watchdogTriggered = true
      watchdogController.abort()
    }, timeoutMs)
  }
  resetWatchdog(FIRST_EVENT_TIMEOUT_MS)

  try {
    for await (const event of streamFn(streamOptsWithWatchdog)) {
      if (!firstEventReceived) {
        firstEventReceived = true
        resetWatchdog(INTER_EVENT_TIMEOUT_MS)
      } else {
        resetWatchdog(INTER_EVENT_TIMEOUT_MS)
      }
      if (watchdogTriggered) break
      switch (event.type) {
        case 'text_delta': {
          textContent += event.content
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

        case 'thinking_block_done': {
          contentBlocks.push({ type: 'thinking', thinking: event.thinking, signature: event.signature })
          break
        }

        case 'tool_use_start': {
          toolNameMap.set(event.id, event.name)
          yield { type: 'agent:tool_call_preview', toolCallId: event.id, toolName: event.name }
          break
        }

        case 'tool_use_end': {
          const toolName = toolNameMap.get(event.id) || ''
          const toolCall: ToolCall = { id: event.id, name: toolName, input: event.parsedInput }
          toolCalls.push(toolCall)
          contentBlocks.push({ type: 'tool_use', id: event.id, name: toolName, input: event.parsedInput })
          yield { type: 'agent:tool_call', toolCallId: event.id, toolName, input: event.parsedInput }
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
    if (watchdogTriggered) {
      // 跳过，走下面的 watchdog 错误路径
    } else if (streamErr instanceof PromptTooLongError) {
      throw streamErr
    } else {
      yield {
        type: 'agent:error',
        error: streamErr instanceof Error ? streamErr.message : String(streamErr),
        recoverable: false,
      }
      hadError = true
    }
  } finally {
    if (eventTimer) clearTimeout(eventTimer)
  }

  // 看门狗触发
  if (watchdogTriggered && !hadError) {
    const phase = firstEventReceived ? 'inter-event' : 'first-event (prefill)'
    const timeoutMs = firstEventReceived ? INTER_EVENT_TIMEOUT_MS : FIRST_EVENT_TIMEOUT_MS
    const errMsg = `Stream idle timeout [${phase}]: no events received in ${timeoutMs / 1000}s`
    errorMessage = errMsg
    yield {
      type: 'agent:error',
      error: errMsg,
      recoverable: true,
    }
    hadError = true
  }

  // Phase 2: 工具结果
  let loopDetected = false
  const toolResults: ToolExecResult[] = []

  if (executor.size > 0) {
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

      if (hadError) {
        toolResults.push(result)
        yield {
          type: 'agent:tool_result',
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          output: result.output,
          isError: result.isError,
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
    errorMessage,
    loopDetected,
    toolResults,
  }
}
