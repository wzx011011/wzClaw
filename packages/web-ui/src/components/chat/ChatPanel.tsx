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

import React, { useState, useRef, useEffect } from 'react'
import MessageList from './MessageList'
import type { StoreApi } from 'zustand'
import type { ChatStore } from '../../stores/chat-store'

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

  useEffect(() => {
    setState(store.getState())
    return store.subscribe(() => {
      setState(store.getState())
    })
  }, [store])

  const { isStreaming, error } = state
  const inputValue = state._inputValue ?? ''
  const setInputValue = (val: string) => {
    store.setState({ _inputValue: val } as unknown as Partial<ChatStore>)
  }

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 自动调整 textarea 高度
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    setInputValue(value)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
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
        <div className="chat-input-area" style={{ position: 'relative' }}>
          <textarea
            ref={textareaRef}
            className="chat-input"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
            rows={1}
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
                  backgroundColor: connected ? '#4caf50' : '#f44336',
                  display: 'inline-block',
                }}
              />
              {connected ? '已连接' : '未连接'}
            </span>
          </div>
          <div className="chat-toolbar-right">
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
