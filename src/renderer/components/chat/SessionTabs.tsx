import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useChatStore } from '../../stores/chat-store'

// ============================================================
// SessionTabs — Tab bar for managing multiple chat sessions
// (per 07-CONTEXT.md: tab bar above chat panel, right-click context menu)
// ============================================================

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  sessionId: string
}

export default function SessionTabs(): JSX.Element {
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const switchSession = useChatStore((s) => s.switchSession)
  const createSession = useChatStore((s) => s.createSession)
  const deleteSessionTab = useChatStore((s) => s.deleteSessionTab)
  const renameSession = useChatStore((s) => s.renameSession)

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextMenu])

  // Auto-dismiss delete confirmation after 5 seconds
  useEffect(() => {
    if (!confirmDeleteId) return
    const timer = setTimeout(() => setConfirmDeleteId(null), 5000)
    return () => clearTimeout(timer)
  }, [confirmDeleteId])

  const handleContextMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, sessionId })
  }, [])

  const handleTabClick = useCallback((sessionId: string) => {
    if (confirmDeleteId) return
    switchSession(sessionId)
  }, [switchSession, confirmDeleteId])

  const handleNewTab = useCallback(() => {
    createSession()
  }, [createSession])

  const handleClose = useCallback((sessionId: string) => {
    if (confirmDeleteId === sessionId) {
      deleteSessionTab(sessionId)
      setConfirmDeleteId(null)
    } else {
      setConfirmDeleteId(sessionId)
    }
  }, [deleteSessionTab, confirmDeleteId])

  const handleStartRename = useCallback((sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId)
    setRenameValue(session?.title || '')
    setRenamingId(sessionId)
    setContextMenu(null)
  }, [sessions])

  const handleFinishRename = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      renameSession(renamingId, renameValue.trim())
    }
    setRenamingId(null)
  }, [renamingId, renameValue, renameSession])

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleFinishRename()
    } else if (e.key === 'Escape') {
      setRenamingId(null)
    }
  }, [handleFinishRename])

  const handleCloseOthers = useCallback((sessionId: string) => {
    sessions.forEach(s => {
      if (s.id !== sessionId) {
        deleteSessionTab(s.id)
      }
    })
    setContextMenu(null)
  }, [sessions, deleteSessionTab])

  const truncateTitle = (title: string, maxLen: number = 25): string => {
    return title.length > maxLen ? title.substring(0, maxLen) + '...' : title
  }

  return (
    <div className="chat-tabs-bar">
      {sessions.map((session) => (
        <div
          key={session.id}
          className={`chat-tab${session.id === activeSessionId ? ' chat-tab-active' : ''}${confirmDeleteId === session.id ? ' chat-tab-confirming' : ''}`}
          onClick={() => handleTabClick(session.id)}
          onContextMenu={(e) => handleContextMenu(e, session.id)}
        >
          {renamingId === session.id ? (
            <input
              ref={renameInputRef}
              className="chat-tab-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={handleFinishRename}
              onKeyDown={handleRenameKeyDown}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="chat-tab-title" title={session.title}>
              {confirmDeleteId === session.id
                ? 'Delete?'
                : truncateTitle(session.title)}
            </span>
          )}
          {session.id !== activeSessionId && (
            <button
              className="chat-tab-close"
              onClick={(e) => {
                e.stopPropagation()
                handleClose(session.id)
              }}
              title={confirmDeleteId === session.id ? 'Confirm delete' : 'Close tab'}
            >
              {confirmDeleteId === session.id ? '!' : '\u00D7'}
            </button>
          )}
        </div>
      ))}
      <button
        className="chat-tab-new"
        onClick={handleNewTab}
        title="New session (Ctrl+T)"
      >
        +
      </button>

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="chat-tab-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="chat-tab-context-item"
            onClick={() => handleStartRename(contextMenu.sessionId)}
          >
            Rename
          </button>
          <button
            className="chat-tab-context-item chat-tab-context-item-danger"
            onClick={() => {
              deleteSessionTab(contextMenu.sessionId)
              setContextMenu(null)
            }}
          >
            Close
          </button>
          {sessions.length > 1 && (
            <button
              className="chat-tab-context-item chat-tab-context-item-danger"
              onClick={() => handleCloseOthers(contextMenu.sessionId)}
            >
              Close Others
            </button>
          )}
        </div>
      )}
    </div>
  )
}
