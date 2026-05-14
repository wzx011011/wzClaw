// ============================================================
// history-window — 消息历史窗口化工具函数
// 从桌面端直接复制，无外部依赖
// ============================================================

import type { ChatMessage } from '../../stores/streaming-batcher'

/** 初始渲染的消息数量 */
export const INITIAL_HISTORY_RENDER_COUNT = 40

/** 是否需要启用历史窗口化（消息数超过阈值） */
export function shouldWindowHistory(messageCount: number): boolean {
  return messageCount > INITIAL_HISTORY_RENDER_COUNT
}

/**
 * 获取当前可见的消息窗口
 *
 * @param messages 全部消息
 * @param historyWindowed 是否启用窗口化
 * @param historyRenderCount 当前渲染数量
 * @returns 可见消息列表和隐藏消息数量
 */
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
