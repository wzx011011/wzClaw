// ============================================================
// MessageList — 消息区域独立组件
//
// 将 messages / streaming state 的订阅隔离在此组件内部，
// 使 ChatPanel 在流式输出期间完全不参与重渲染。
// 每次 rAF 帧只有此组件及其子树需要更新。
// ============================================================

import React, { useState, useRef, useEffect, useMemo } from 'react'
import ChatMessage from './ChatMessage'
import ThinkingIndicator from './ThinkingIndicator'
import {
  getVisibleHistoryWindow,
  INITIAL_HISTORY_RENDER_COUNT,
} from './history-window'
import type { ChatStore } from '../../stores/chat-store'

/**
 * Props — 注入 useChatStore hook
 * 避免硬编码全局 store 引用，便于测试
 */
interface MessageListProps {
  useStore: () => ChatStore
}

export default function MessageList({ useStore }: MessageListProps): React.ReactElement {
  // 订阅高频更新的 store 字段
  const messages = useStore().messages
  const isStreaming = useStore().isStreaming
  const isWaitingForResponse = useStore().isWaitingForResponse
  const streamingMessageId = useStore().streamingMessageId
  const streamJustEnded = useStore().streamJustEnded

  // 历史窗口化与滚动本地状态
  const [historyWindowed, setHistoryWindowed] = useState(false)
  const [historyRenderCount, setHistoryRenderCount] = useState(INITIAL_HISTORY_RENDER_COUNT)
  const [userScrolledUp, setUserScrolledUp] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)

  // ---- 派生值 ----
  const { visibleMessages, hiddenMessageCount } = useMemo(
    () => getVisibleHistoryWindow(messages, historyWindowed, historyRenderCount),
    [messages, historyWindowed, historyRenderCount]
  )

  const scrollAnchorKey = useMemo(() => {
    const lastMessage = messages[messages.length - 1]
    const lastToolSignature =
      lastMessage?.toolCalls
        ?.map((tc: { id: string; status: string; output?: string }) => `${tc.id}:${tc.status}:${tc.output?.length ?? 0}`)
        .join('|') ?? ''
    return [
      messages.length,
      lastMessage?.id ?? '',
      lastMessage?.content.length ?? 0,
      lastMessage?.thinkingContent?.length ?? 0,
      lastMessage?.isStreaming ? 1 : 0,
      lastToolSignature,
      isWaitingForResponse ? 1 : 0,
      streamingMessageId ?? '',
    ].join(':')
  }, [messages, isWaitingForResponse, streamingMessageId])

  // ---- 自动滚动到底部 ----
  useEffect(() => {
    if (userScrolledUp) return
    if (isStreaming) {
      // 流式：直接设置 scrollTop，避免 scrollIntoView 的强制同步 layout
      const container = messagesContainerRef.current
      if (container) container.scrollTop = container.scrollHeight
    } else {
      const raf = requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' })
      })
      return () => cancelAnimationFrame(raf)
    }
  }, [scrollAnchorKey, userScrolledUp, isStreaming])

  // ---- 流结束后强制滚到底部 ----
  useEffect(() => {
    if (streamJustEnded) {
      setUserScrolledUp(false)
      const container = messagesContainerRef.current
      if (container) container.scrollTop = container.scrollHeight
    }
  }, [streamJustEnded])

  // ---- 监听用户向上滚动 ----
  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return
    let rafId = 0
    const handleScroll = (): void => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const distanceFromBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight
        setUserScrolledUp(distanceFromBottom > 100)
      })
    }
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      container.removeEventListener('scroll', handleScroll)
    }
  }, [])

  // ---- 消息数量降回阈值以下时自动关闭历史窗口 ----
  useEffect(() => {
    if (messages.length <= INITIAL_HISTORY_RENDER_COUNT && historyWindowed) {
      setHistoryWindowed(false)
    }
  }, [messages.length, historyWindowed])

  // ---- 历史展开处理器 ----
  const handleRevealMoreHistory = (): void => {
    const nextCount = Math.min(messages.length, historyRenderCount + INITIAL_HISTORY_RENDER_COUNT)
    setHistoryRenderCount(nextCount)
    if (nextCount >= messages.length) {
      setHistoryWindowed(false)
    }
  }

  const handleRevealAllHistory = (): void => {
    setHistoryRenderCount(messages.length)
    setHistoryWindowed(false)
  }

  return (
    <div className="chat-messages" ref={messagesContainerRef} style={{ position: 'relative' }}>
      {messages.length === 0 ? (
        <div className="chat-empty">
          开始新的对话
          <span className="chat-empty-hint">输入消息发送给 AI 助手</span>
        </div>
      ) : (
        <>
          {hiddenMessageCount > 0 && (
            <div className="history-window-banner">
              <div className="history-window-copy">
                显示 {visibleMessages.length} / {visibleMessages.length + hiddenMessageCount} 条消息
              </div>
              <div className="history-window-actions">
                <button className="history-window-btn" onClick={handleRevealMoreHistory}>
                  加载更多 ({Math.min(hiddenMessageCount, INITIAL_HISTORY_RENDER_COUNT)})
                </button>
                <button
                  className="history-window-btn history-window-btn-secondary"
                  onClick={handleRevealAllHistory}
                >
                  展开全部
                </button>
              </div>
            </div>
          )}
          {visibleMessages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} />
          ))}
        </>
      )}
      {isStreaming && isWaitingForResponse && !streamingMessageId && (
        <div className="chat-message chat-message-assistant chat-message-streaming">
          <ThinkingIndicator />
        </div>
      )}
      <div ref={messagesEndRef} />
      <button
        className={`scroll-to-bottom-btn${userScrolledUp ? ' visible' : ''}`}
        onClick={() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
          setUserScrolledUp(false)
        }}
        title="滚动到底部"
      >
        ↓
      </button>
    </div>
  )
}
