import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../stores/chat-store'
import {
  getVisibleHistoryWindow,
  INITIAL_HISTORY_RENDER_COUNT,
  shouldWindowHistory,
} from '../chat/history-window'

function makeMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index + 1}`,
    timestamp: index + 1,
  }))
}

describe('history window helpers', () => {
  it('keeps short conversations fully visible', () => {
    expect(shouldWindowHistory(INITIAL_HISTORY_RENDER_COUNT)).toBe(false)
    expect(shouldWindowHistory(INITIAL_HISTORY_RENDER_COUNT - 1)).toBe(false)
  })

  it('windows long conversations to the most recent slice', () => {
    const messages = makeMessages(INITIAL_HISTORY_RENDER_COUNT + 12)

    const result = getVisibleHistoryWindow(messages, true, INITIAL_HISTORY_RENDER_COUNT)

    expect(shouldWindowHistory(messages.length)).toBe(true)
    expect(result.hiddenMessageCount).toBe(12)
    expect(result.visibleMessages).toHaveLength(INITIAL_HISTORY_RENDER_COUNT)
    expect(result.visibleMessages[0]?.id).toBe('msg-13')
    expect(result.visibleMessages.at(-1)?.id).toBe(`msg-${messages.length}`)
  })

  it('returns all messages when history windowing is disabled', () => {
    const messages = makeMessages(INITIAL_HISTORY_RENDER_COUNT + 20)

    const result = getVisibleHistoryWindow(messages, false, INITIAL_HISTORY_RENDER_COUNT)

    expect(result.hiddenMessageCount).toBe(0)
    expect(result.visibleMessages).toEqual(messages)
  })
})