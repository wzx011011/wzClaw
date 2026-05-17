// ============================================================
// SessionList — 会话列表组件
//
// 从桌面端 SessionList.tsx（289 行）简化提取：
// 保留：搜索过滤、时间分组（today/yesterday/earlier）、右键菜单（删除、重命名）
// 保留：当前会话高亮、双击重命名
// 移除：completedSessionIds 角标（简化）
// 移除：runningSessionIds 指示（简化）
// 移除：workspaceStore 依赖（无 workspace 概念）
// 移除：duplicateSession（简化）
// 移除：pinSession / unpinSession（简化）
// 移除：wzxclaw:shortcut 全局事件（无 Electron）
// 通过 props 注入 store 实例（与 ChatPanel 一致）
// 约 180 行
// ============================================================

import React, { useState, useEffect, useRef, useMemo } from 'react'
import type { StoreApi } from 'zustand'
import type { ChatStore } from '../../stores/chat-store'
import ContextMenu, { type ContextMenuItem } from '../ui/ContextMenu'
import type { SessionMeta } from '../../data-source/types'

/** 判断会话属于哪个时间分组 */
function getSessionGroup(timestamp: number): 'today' | 'yesterday' | 'earlier' {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86400000

  if (timestamp >= todayStart) return 'today'
  if (timestamp >= yesterdayStart) return 'yesterday'
  return 'earlier'
}

/** 时间分组排序顺序 */
const GROUP_ORDER: string[] = ['today', 'yesterday', 'earlier']

/** 时间分组中文名 */
const GROUP_LABELS: Record<string, string> = {
  today: '今天',
  yesterday: '昨天',
  earlier: '更早',
}

/** 格式化相对时间 */
function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(months / 12)} 年前`
}

type ContextMenuState = { x: number; y: number; sessionId: string } | null

interface SessionListProps {
  /** Zustand store 实例（通过 props 注入，与 ChatPanel 一致） */
  store: StoreApi<ChatStore>
}

/**
 * SessionList — 会话列表
 *
 * 通过 props 注入 store 实例，监听 sessions / conversationId 状态变化。
 * 支持搜索过滤、时间分组、右键菜单（删除、重命名）、当前会话高亮。
 */
export default function SessionList({ store }: SessionListProps): React.ReactElement {
  // 仅跟踪会话列表与激活会话，避免流式消息时整侧栏高频重渲染
  const [state, setState] = useState(() => {
    const current = store.getState()
    return { sessions: current.sessions, conversationId: current.conversationId }
  })

  useEffect(() => {
    const current = store.getState()
    setState({ sessions: current.sessions, conversationId: current.conversationId })
    return store.subscribe(() => {
      const next = store.getState()
      setState((prev) => {
        if (prev.sessions === next.sessions && prev.conversationId === next.conversationId) {
          return prev
        }
        return { sessions: next.sessions, conversationId: next.conversationId }
      })
    })
  }, [store])

  const { sessions, conversationId } = state
  const switchSession = store.getState().switchSession
  const deleteSession = store.getState().deleteSession
  const renameSession = store.getState().renameSession
  const loadSessionList = store.getState().loadSessionList

  const [searchQuery, setSearchQuery] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const initializedRef = useRef(false)

  // 初始加载会话列表（仅一次）
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true
      loadSessionList()
    }
  }, [loadSessionList])

  // 客户端搜索过滤
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions
    const lower = searchQuery.toLowerCase()
    return sessions.filter((s: SessionMeta) =>
      s.title.toLowerCase().includes(lower) ||
      (s.preview && s.preview.toLowerCase().includes(lower))
    )
  }, [sessions, searchQuery])

  // 按时间分组
  const groupedSessions = useMemo(() => {
    const groups: Record<string, SessionMeta[]> = {}
    for (const session of filteredSessions) {
      const group = getSessionGroup(session.updatedAt)
      if (!groups[group]) groups[group] = []
      groups[group].push(session)
    }
    return groups
  }, [filteredSessions])

  // 自动聚焦重命名输入框
  useEffect(() => {
    if (editingSessionId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingSessionId])

  // 5 秒后自动取消删除确认
  useEffect(() => {
    if (!confirmDeleteId) return
    const timer = setTimeout(() => setConfirmDeleteId(null), 5000)
    return () => clearTimeout(timer)
  }, [confirmDeleteId])

  const handleContextMenu = (e: React.MouseEvent, sessionId: string): void => {
    e.preventDefault()
    e.stopPropagation()
    setConfirmDeleteId(null)
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId })
  }

  const handleStartRename = (sessionId: string, currentTitle: string): void => {
    setContextMenu(null)
    setEditingSessionId(sessionId)
    setEditTitle(currentTitle)
  }

  const handleCommitRename = (): void => {
    if (editingSessionId && editTitle.trim()) {
      renameSession(editingSessionId, editTitle.trim())
    }
    setEditingSessionId(null)
    setEditTitle('')
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleCommitRename()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setEditingSessionId(null)
      setEditTitle('')
    }
  }

  const handleConfirmDelete = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (confirmDeleteId) {
      deleteSession(confirmDeleteId)
    }
    setConfirmDeleteId(null)
    setContextMenu(null)
  }

  // 右键菜单项
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return []
    const session = sessions.find((s: SessionMeta) => s.id === contextMenu.sessionId)
    if (!session) return []
    return [
      { label: '重命名', shortcut: 'F2', onClick: () => handleStartRename(session.id, session.title) },
      { separator: true, label: '', onClick: () => {} },
      { label: '删除', danger: true, onClick: () => setConfirmDeleteId(session.id) },
    ]
  }, [contextMenu, sessions])

  /** 渲染单个会话项 */
  const renderSessionItem = (session: SessionMeta): React.ReactElement => (
    <div
      key={session.id}
      className={`session-item${session.id === conversationId ? ' active' : ''}`}
      onClick={() => {
        if (confirmDeleteId !== session.id && editingSessionId !== session.id) {
          switchSession(session.id)
        }
      }}
      onContextMenu={(e) => handleContextMenu(e, session.id)}
    >
      {confirmDeleteId === session.id ? (
        <div className="session-item-confirm">
          <span>确认删除？</span>
          <button className="session-confirm-btn danger" onClick={handleConfirmDelete}>删除</button>
          <button className="session-confirm-btn" onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); setContextMenu(null) }}>取消</button>
        </div>
      ) : (
        <div className="session-item-info">
          {editingSessionId === session.id ? (
            <input
              ref={inputRef}
              className="session-item-title-input"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={handleCommitRename}
              onKeyDown={handleRenameKeyDown}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <div
              className="session-item-title"
              onDoubleClick={(e) => {
                e.stopPropagation()
                handleStartRename(session.id, session.title)
              }}
              title="双击重命名"
            >
              {session.title}
            </div>
          )}
          {session.preview && session.preview !== session.title && (
            <div className="session-item-preview" title={session.preview}>
              {session.preview}
            </div>
          )}
          <div className="session-item-time">
            {formatRelativeTime(session.updatedAt)}
            {session.messageCount > 0 && ` · ${session.messageCount} 条消息`}
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className="session-list">
      {/* 搜索框 */}
      <div className="session-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          placeholder="搜索会话..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button className="session-search-clear" onClick={() => setSearchQuery('')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* 会话分组列表 */}
      <div className="session-list-body">
        {filteredSessions.length === 0 ? (
          <div className="session-list-empty">
            <p>{searchQuery ? '没有匹配的会话' : '暂无会话'}</p>
            <p>{searchQuery ? '尝试其他关键词' : '开始新的对话吧'}</p>
          </div>
        ) : (
          GROUP_ORDER.filter(g => groupedSessions[g]?.length).map(group => (
            <div key={group}>
              <div className="session-group-header">{GROUP_LABELS[group]}</div>
              {groupedSessions[group]!.map(renderSessionItem)}
            </div>
          ))
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
