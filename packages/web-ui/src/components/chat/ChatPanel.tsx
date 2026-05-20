// ============================================================
// ChatPanel — 聊天主面板
//
// 从桌面端 ChatPanel.tsx（964 行）简化提取：
// 保留：消息输入框 + 发送按钮 + Enter 发送 / Shift+Enter 换行
// 保留：isStreaming 时显示停止按钮
// 保留：连接状态指示器
// 移除：@Mention / Slash commands / DiffPreview / StepPanel / Permission
// 移除：Thinking depth / Permission mode 选择器
// 移除：Settings / PluginManager 内嵌面板
// ============================================================

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import MessageList from './MessageList'
import MicButton from '../mobile/MicButton'
import SlashCommandPicker from './SlashCommandPicker'
import MentionPicker from './MentionPicker'
import type { MentionItem } from './MentionPicker'
import { useHandStore } from '../../stores/hand-store'
import type { StoreApi } from 'zustand'
import type { ChatStore } from '../../stores/chat-store'

/** 检测移动端视口（<=768px） */
function isMobileViewport(): boolean {
  return window.innerWidth <= 768
}

/**
 * ChatPanel Props
 *
 * 通过 props 注入 store 实例，避免组件直接依赖全局变量
 */
interface ChatPanelProps {
  store: StoreApi<ChatStore>
  /** 连接状态（从 DataSource.onConnectionChange 读取） */
  connected?: boolean
  /** 当前模型名称（可选显示） */
  modelName?: string
}

/**
 * ChatPanel — 聊天主面板
 *
 * 组合：
 * - MessageList：消息列表（隔离高频流式更新）
 * - 输入框：textarea + 发送/停止按钮
 * - 工具栏：连接状态 + 模型名称
 */
export default function ChatPanel({ store, connected = false, modelName }: ChatPanelProps): React.ReactElement {
  // 通过订阅获取最新状态
  const [state, setState] = useState(store.getState())

  // 移动端状态（用于 placeholder 文本切换）
  const [isMobile, setIsMobile] = useState(() => isMobileViewport())

  useEffect(() => {
    setState(store.getState())
    return store.subscribe(() => {
      setState(store.getState())
    })
  }, [store])

  // 监听视口变化，更新移动端状态
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(isMobileViewport())
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const { isStreaming, error, sessionCost } = state
  const inputValue = state._inputValue ?? ''
  const setInputValue = (val: string) => {
    store.setState({ _inputValue: val } as unknown as Partial<ChatStore>)
  }

  // 根据视口宽度选择 placeholder 文本
  const placeholder = isMobile
    ? '输入消息...'
    : '输入消息... (Enter 发送, Shift+Enter 换行)'

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 斜线命令选择器状态
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  // @提及选择器状态
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const inputAreaRef = useRef<HTMLDivElement>(null)

  // 生成提及候选项：Hand 列表
  // 注意：必须先获取稳定的 hands 引用，再用 useMemo 转换
  // 不能在 Zustand selector 内直接 .map()，否则每次都返回新数组引用
  // 导致 useSyncExternalStore 的 tearing 检测触发无限重渲染（React Error #185）
  const hands = useHandStore((s) => s.hands)
  const mentionItems: MentionItem[] = useMemo(() => hands.map((h) => ({
    id: h.id,
    label: h.id,
    value: `@${h.id}`,
    type: 'hand' as const,
    description: h.capabilities.slice(0, 3).join(', '),
  })), [hands])

  // 自动调整 textarea 高度
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    setInputValue(value)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
    }

    // 检测斜线命令：输入框内以 '/' 开头
    if (value.startsWith('/')) {
      setSlashQuery(value.slice(1))
      setSlashOpen(true)
      setMentionOpen(false)
    } else {
      setSlashOpen(false)
    }

    // 检测 @ 提及：找到最后一个 '@'
    const atIdx = value.lastIndexOf('@')
    if (atIdx !== -1) {
      const after = value.slice(atIdx + 1)
      if (!/\s/.test(after)) {
        setMentionQuery(after)
        setMentionOpen(true)
        setSlashOpen(false)
      } else {
        setMentionOpen(false)
      }
    } else {
      setMentionOpen(false)
    }
  }

  // 发送消息
  const handleSend = async (): Promise<void> => {
    const trimmed = inputValue.trim()
    if (!trimmed) return

    await store.getState().sendMessage(trimmed)
    setInputValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  // 键盘事件处理
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
      return
    }
  }

  // 创建 MessageList 使用的 hook
  const useStore = () => store.getState()

  return (
    <div className="chat-panel">
      {/* 斜线命令选择器 */}
      {slashOpen && (
        <SlashCommandPicker
          query={slashQuery}
          anchorRef={inputAreaRef as React.RefObject<HTMLElement>}
          onSelect={(template) => {
            setInputValue(template)
            setSlashOpen(false)
          }}
          onClose={() => setSlashOpen(false)}
        />
      )}
      {/* @提及选择器 */}
      {mentionOpen && (
        <MentionPicker
          query={mentionQuery}
          items={mentionItems}
          anchorRef={inputAreaRef as React.RefObject<HTMLElement>}
          onSelect={(item) => {
            const atIdx = inputValue.lastIndexOf('@')
            const newVal = inputValue.slice(0, atIdx) + item.value + ' '
            setInputValue(newVal)
            setMentionOpen(false)
          }}
          onClose={() => setMentionOpen(false)}
        />
      )}
      {/* 消息列表 — 高频更新隔离在此组件内部 */}
      <MessageList useStore={useStore} />

      {/* 错误提示 */}
      {error && (
        <div className="chat-error">
          <span>{error}</span>
        </div>
      )}

      {/* 输入区域 */}
      <div className="chat-input-area-wrapper">
        <div ref={inputAreaRef} className="chat-input-area" style={{ position: 'relative' }}>
          <textarea
            ref={textareaRef}
            className="chat-input"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            aria-label="聊天输入框"
            rows={1}
            style={{ touchAction: 'manipulation' }}
          />
        </div>
        {/* 底部工具栏 */}
        <div className="chat-input-toolbar">
          <div className="chat-toolbar-left">
            {/* 连接状态指示器 */}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '11px',
                color: connected ? 'var(--tool-completed)' : 'var(--tool-error)',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: connected ? 'var(--status-connected)' : 'var(--status-disconnected)',
                  display: 'inline-block',
                }}
              />
              {connected ? '已连接' : '未连接'}
            </span>
            {/* 语音输入按钮 */}
            {isMobile && (
              <MicButton onTranscript={(text) => setInputValue(text)} />
            )}
          </div>
          <div className="chat-toolbar-right">
            {/* 用量/费用指示器 */}
            {sessionCost && (
              <span
                style={{
                  fontSize: '11px',
                  color: 'var(--text-secondary)',
                  whiteSpace: 'nowrap',
                }}
                title={`输入: ${sessionCost.inputTokens.toLocaleString()} tokens · 输出: ${sessionCost.outputTokens.toLocaleString()} tokens`}
              >
                {sessionCost.totalCostUSD < 0.01
                  ? `$${sessionCost.totalCostUSD.toFixed(4)}`
                  : `$${sessionCost.totalCostUSD.toFixed(2)}`}
              </span>
            )}
            {/* 模型标签 */}
            {modelName && (
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                {modelName}
              </span>
            )}
            {/* 发送 / 停止按钮 */}
            {isStreaming ? (
              <button
                className="chat-stop-btn"
                onClick={() => store.getState().stopGeneration()}
                title="停止生成"
                style={{ touchAction: 'manipulation' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                className="chat-send-btn"
                onClick={handleSend}
                disabled={!inputValue.trim()}
                title="发送消息"
                style={{ touchAction: 'manipulation' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
