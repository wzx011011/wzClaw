// ============================================================
// Chat store shared utilities — extracted from chat-store.ts
// ============================================================
import type { ChatMessage } from '@shared/types'

/**
 * Update a message by ID using an updater function.
 * Fast path: streaming scenarios where target is the last element.
 */
export function updateMessageById(
  messages: ChatMessage[],
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage
): ChatMessage[] | null {
  const lastIndex = messages.length - 1
  // 快速路径：流式场景下目标消息几乎总是最后一个元素
  if (lastIndex >= 0 && messages[lastIndex]?.id === messageId) {
    const updated = updater(messages[lastIndex])
    if (updated === messages[lastIndex]) return null // 无变化
    // slice(0, -1) 底层是 memcpy，比 [...messages] spread 更高效
    const next = messages.slice(0, -1)
    next.push(updated)
    return next
  }
  // 慢速路径：全量扫描（极少触发）
  const index = messages.findIndex((message) => message.id === messageId)
  if (index < 0) return null

  const nextMessages = [...messages]
  nextMessages[index] = updater(messages[index])
  return nextMessages
}
