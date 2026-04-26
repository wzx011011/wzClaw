import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useChatStore } from '../../stores/chat-store'
import { useLayoutStore } from '../../stores/layout-store'
import ContextMenu, { type ContextMenuItem } from '../ui/ContextMenu'
import type { SessionMeta } from '../../../shared/types'

// ============================================================
// SessionList — 增强版会话列表
// 支持：搜索过滤、时间分组、会话预览、右键菜单、置顶
// ============================================================

/** 相对时间格式化（中文） */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days < 2) return '昨天'

  const date = new Date(timestamp)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

/** 判断会话属于哪个时间分组 */
function getSessionGroup(timestamp: number): 'today' | 'yesterday' | 'earlier' {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86400000

  if (timestamp >= todayStart) return 'today'
  if (timestamp >= yesterdayStart) return 'yesterday'
  return 'earlier'
}

const GROUP_LABELS: Record<string, string> = {
  pinned: '📌 置顶',
  today: '今天',
  yesterday: '昨天',
  earlier: '更早',
}

const GROUP_ORDER: string[] = ['pinned', 'today', 'yesterday', 'earlier']

type ContextMenuState = { x: number; y: number; sessionId: string } | null

export default function SessionList(): JSX.Element | null {
  const sessions = useChatStore((s) => s.sessions)
  const conversationId = useChatStore((s) => s.conversationId)
  const switchSession = useChatStore((s) => s.switchSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const renameSession = useChatStore((s) => s.renameSession)
  const duplicateSession = useChatStore((s) => s.duplicateSession)

  const pinnedSessionIds = useLayoutStore((s) => s.pinnedSessionIds)
  const pinSession = useLayoutStore((s) => s.pinSession)
  const unpinSession = useLayoutStore((s) => s.unpinSession)

  const [searchQuery, setSearchQuery] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // 客户端过滤
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions
    const lower = searchQuery.toLowerCase()
    return sessions.filter(s =>
      s.title.toLowerCase().includes(lower) ||
      (s.preview && s.preview.toLowerCase().includes(lower))
    )
  }, [sessions, searchQuery])

  // 分组：置顶 + 时间分组
  const groupedSessions = useMemo(() => {
    const groups: Record<string, SessionMeta[]> = {}
    for (const session of filteredSessions) {
      let group: string
      if (pinnedSessionIds.includes(session.id)) {
        group = 'pinned'
      } else {
        group = getSessionGroup(session.updatedAt)
      }
      if (!groups[group]) groups[group] = []
      groups[group].push(session)
    }
    return groups
  }, [filteredSessions, pinnedSessionIds])

  // Auto-focus input when editing starts
  useEffect(() => {
    if (editingSessionId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingSessionId])

  // Auto-dismiss confirmation after 5 seconds
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

  // 键盘快捷键: F2 重命名当前会话, Delete 删除当前会话
  useEffect(() => {
    const handleRename = () => {
      if (conversationId) {
        const session = sessions.find(s => s.id === conversationId)
        if (session) handleStartRename(session.id, session.title)
      }
    }
    const handleDelete = () => {
      if (conversationId) setConfirmDeleteId(conversationId)
    }
    window.addEventListener('wzxclaw:shortcut-rename', handleRename)
    window.addEventListener('wzxclaw:shortcut-delete', handleDelete)
    return () => {
      window.removeEventListener('wzxclaw:shortcut-rename', handleRename)
      window.removeEventListener('wzxclaw:shortcut-delete', handleDelete)
    }
  }, [conversationId, sessions, handleStartRename])

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
      unpinSession(confirmDeleteId)
      deleteSession(confirmDeleteId)
    }
    setConfirmDeleteId(null)
    setContextMenu(null)
  }

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return []
    const session = sessions.find(s => s.id === contextMenu.sessionId)
    if (!session) return []
    const isPinned = pinnedSessionIds.includes(session.id)
    return [
      { label: '重命名', shortcut: 'F2', onClick: () => handleStartRename(session.id, session.title) },
      { label: isPinned ? '取消置顶' : '置顶', onClick: () => isPinned ? unpinSession(session.id) : pinSession(session.id) },
      { label: '复制会话', onClick: () => duplicateSession(session.id) },
      { separator: true, label: '', onClick: () => {} },
      { label: '删除', onClick: () => setConfirmDeleteId(session.id) },
    ]
  }, [contextMenu, sessions, pinnedSessionIds, handleStartRename, unpinSession, pinSession, duplicateSession])

  const renderSessionItem = (session: SessionMeta): JSX.Element => (
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
          <span>确定删除此会话？此操作不可撤销。</span>
          <button className="permission-btn permission-btn-deny" onClick={handleConfirmDelete}>删除</button>
          <button className="permission-btn" onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); setContextMenu(null) }}>取消</button>
        </div>
      ) : (
        <>
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
                title="双击重命名，右键更多操作"
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
        </>
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
          ref={searchInputRef}
          type="text"
          placeholder="搜索会话..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button className="session-search-clear" onClick={() => setSearchQuery('')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            <p>{searchQuery ? '尝试其他关键词' : '开始对话以创建会话'}</p>
          </div>
        ) : (
          GROUP_ORDER.filter(g => groupedSessions[g]?.length).map(group => (
            <div key={group}>
              <div className="session-group-header">{GROUP_LABELS[group]}</div>
              {groupedSessions[group].map(renderSessionItem)}
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
