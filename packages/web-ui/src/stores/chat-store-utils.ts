// ============================================================
// Chat store 共享工具函数
// 从桌面端 chat-store-utils.ts 提取，无 Electron 依赖
// ============================================================

import { v4 as uuidv4 } from 'uuid'
import type { ChatMessage } from './streaming-batcher'

/** 内部可变版本 — 用于 buildChatMessagesFromRaw 构造 */
type MutableChatMessage = {
  -readonly [K in keyof ChatMessage]: ChatMessage[K]
}

/**
 * 将持久化的原始消息数组转换为 ChatMessage[]。
 * 用于 loadSession 等场景。
 */
export function buildChatMessagesFromRaw(
  rawMessages: Array<Record<string, unknown>>
): ChatMessage[] {
  const parsed = rawMessages.map((msg) => ({
    id: (msg.id as string) || uuidv4(),
    role: msg.role as 'user' | 'assistant' | 'tool_result',
    content: msg.content as string,
    thinkingContent: msg.thinkingContent as string | undefined,
    timestamp: msg.timestamp as number,
    toolCalls: msg.toolCalls as Array<{ id: string; name: string; input?: Record<string, unknown> }> | undefined,
    toolCallId: msg.toolCallId as string | undefined,
    isError: msg.isError as boolean | undefined,
    usage: msg.usage as { inputTokens: number; outputTokens: number } | undefined,
    isCompacted: msg.isCompacted as boolean | undefined
  }))

  // 收集 tool_result 的输出，用于关联到 toolCalls
  const toolResultMap = new Map<string, { output: string; isError: boolean }>()
  for (const msg of parsed) {
    if (msg.role === 'tool_result' && msg.toolCallId) {
      toolResultMap.set(msg.toolCallId, {
        output: (msg.content || '').slice(0, 2000),
        isError: !!msg.isError
      })
    }
  }

  const result: MutableChatMessage[] = []
  for (const msg of parsed) {
    // 跳过 tool_result 消息（其内容已合并到对应 toolCall 中）
    if (msg.role === 'tool_result') continue
    // 跳过 system-reminder 消息
    if (msg.role === 'user' && msg.content && msg.content.startsWith('<system-reminder>')) continue

    const chatMsg: ChatMessage = {
      id: msg.id,
      role: msg.role,
      content: msg.content || '',
      thinkingContent: msg.thinkingContent,
      timestamp: msg.timestamp,
      usage: msg.usage,
      isCompacted: msg.isCompacted
    }

    // 将 toolCalls 及其结果合并到 assistant 消息中
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      (chatMsg as MutableChatMessage).toolCalls = msg.toolCalls.map((tc) => {
        const tcResult = toolResultMap.get(tc.id)
        return {
          id: tc.id,
          name: tc.name,
          status: tcResult ? (tcResult.isError ? 'error' as const : 'completed' as const) : 'completed' as const,
          input: tc.input,
          output: tcResult?.output,
          isError: tcResult?.isError
        }
      })
    }

    result.push(chatMsg)
  }
  return result
}
