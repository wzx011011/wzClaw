import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useT } from '../../i18n/useT'
import { useChatStore } from '../../stores/chat-store'
import ChatMessage from './ChatMessage'
import ThinkingIndicator from './ThinkingIndicator'
import {
  getVisibleHistoryWindow,
  INITIAL_HISTORY_RENDER_COUNT,
  shouldWindowHistory,
} from './history-window'

// ============================================================
// MessageList — 消息区域独立组件
// 将 messages / streaming state 的订阅隔离在此组件内部，
// 使 ChatPanel（输入框、工具栏、plan 面板等）在流式输出期间完全不参与重渲。
// 每次 rAF 帧只有此组件及其子树需要更新。
// ============================================================

export default function MessageList(): JSX.Element {
  const t = useT()
  // 订阅高频更新的 store 字段（每个 rAF 帧都可能变化）
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const isWaitingForResponse = useChatStore((s) => s.isWaitingForResponse)
  const streamingMessageId = useChatStore((s) => s.streamingMessageId)
  const streamJustEnded = useChatStore((s) => s.streamJustEnded)
  // 低频字段（会话切换时变化）
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const isLoadingSession = useChatStore((s) => s.isLoadingSession)

  // 历史窗口化与滚动本地状态
  const [historyWindowed, setHistoryWindowed] = useState(false)
  const [historyRenderCount, setHistoryRenderCount] = useState(INITIAL_HISTORY_RENDER_COUNT)
  const [userScrolledUp, setUserScrolledUp] = useState(false)

  const handleRewind = useCallback((targetMessageId: string) => {
    useChatStore.getState().rewindToMessage(targetMessageId)
  }, [])

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const previousSessionIdRef = useRef(activeSessionId)
  const previousLoadingSessionRef = useRef(isLoadingSession)

  // ---- 派生值（useMemo 避免每帧重算） ----
  const lastMessage = messages[messages.length - 1]
  const { visibleMessages, hiddenMessageCount } = useMemo(
    () => getVisibleHistoryWindow(messages, historyWindowed, historyRenderCount),
    [messages, historyWindowed, historyRenderCount]
  )
  const scrollAnchorKey = useMemo(() => {
    const lastToolSignature =
      lastMessage?.toolCalls
        ?.map((tc) => `${tc.id}:${tc.status}:${tc.output?.length ?? 0}`)
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
  }, [messages.length, lastMessage, isWaitingForResponse, streamingMessageId])

  // ---- 自动滚动到底部 ----
  // 流式期间用 scrollTop 直接设置（无强制同步 layout），
  // 非流式保持 scrollIntoView 行为
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
      useChatStore.setState({ streamJustEnded: false })
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

  // ---- 会话切换：重置历史窗口与滚动状态 ----
  useEffect(() => {
    if (previousSessionIdRef.current === activeSessionId) return
    previousSessionIdRef.current = activeSessionId
    setHistoryRenderCount(INITIAL_HISTORY_RENDER_COUNT)
    setHistoryWindowed(shouldWindowHistory(messages.length))
    setUserScrolledUp(false)
  }, [activeSessionId, messages.length])

  // ---- 会话加载完成：重置历史窗口 ----
  useEffect(() => {
    if (previousLoadingSessionRef.current && !isLoadingSession) {
      setHistoryRenderCount(INITIAL_HISTORY_RENDER_COUNT)
      setHistoryWindowed(shouldWindowHistory(messages.length))
    }
    previousLoadingSessionRef.current = isLoadingSession
  }, [isLoadingSession, messages.length])

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
        isLoadingSession ? (
          <div className="session-loading-skeleton">
            <div className="skeleton-line skeleton-bubble-user" />
            <div className="skeleton-line skeleton-bubble-assistant" />
            <div className="skeleton-line skeleton-bubble-user-sm" />
            <div className="skeleton-line skeleton-bubble-assistant-sm" />
            <div className="skeleton-line skeleton-bubble-user" />
            <div className="skeleton-line skeleton-bubble-assistant" />
          </div>
        ) : (
          <div className="chat-empty">
            {t('messageList.emptyState')}
            <span className="chat-empty-hint">{t('messageList.hint')}</span>
          </div>
        )
      ) : (
        <>
          {hiddenMessageCount > 0 && (
            <div className="history-window-banner">
              <div className="history-window-copy">
                {t('messageList.historyBanner', { visible: visibleMessages.length, total: visibleMessages.length + hiddenMessageCount })}
              </div>
              <div className="history-window-actions">
                <button className="history-window-btn" onClick={handleRevealMoreHistory}>
                  {t('messageList.loadMore', { count: Math.min(hiddenMessageCount, INITIAL_HISTORY_RENDER_COUNT) })}
                </button>
                <button
                  className="history-window-btn history-window-btn-secondary"
                  onClick={handleRevealAllHistory}
                >
                  {t('messageList.expandAll')}
                </button>
              </div>
            </div>
          )}
          {visibleMessages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} onRewind={handleRewind} />
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
        title={t('messageList.scrollToBottom')}
      >
        ↓
      </button>
    </div>
  )
}
