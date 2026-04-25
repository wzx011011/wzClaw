import type { ChatMessage } from '../../stores/chat-store'

export const INITIAL_HISTORY_RENDER_COUNT = 40

export function shouldWindowHistory(messageCount: number): boolean {
  return messageCount > INITIAL_HISTORY_RENDER_COUNT
}

export function getVisibleHistoryWindow(
  messages: ChatMessage[],
  historyWindowed: boolean,
  historyRenderCount: number
): {
  visibleMessages: ChatMessage[]
  hiddenMessageCount: number
} {
  if (!historyWindowed) {
    return {
      visibleMessages: messages,
      hiddenMessageCount: 0
    }
  }

  const safeRenderCount = Math.max(historyRenderCount, 0)
  const visibleMessages = messages.slice(-safeRenderCount)

  return {
    visibleMessages,
    hiddenMessageCount: Math.max(messages.length - visibleMessages.length, 0)
  }
}