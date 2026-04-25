import React, { useState, useEffect, useRef } from 'react'
import { useChatStore } from '../../stores/chat-store'

// ============================================================
// SessionList — Collapsible session history panel (per UI-SPEC Component 2)
// ============================================================

interface SessionListProps {
  isOpen: boolean
  onToggle: () => void
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`
  if (days < 2) return 'yesterday'

  // Format as "MMM D"
  const date = new Date(timestamp)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[date.getMonth()]} ${date.getDate()}`
}

export default function SessionList({ isOpen, onToggle }: SessionListProps): JSX.Element | null {
  const sessions = useChatStore((s) => s.sessions)
  const conversationId = useChatStore((s) => s.conversationId)
  const switchSession = useChatStore((s) => s.switchSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const renameSession = useChatStore((s) => s.renameSession)

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

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

  if (!isOpen) return null

  const handleSelectSession = (sessionId: string): void => {
    switchSession(sessionId)
    onToggle()
  }

  const handleDeleteClick = (e: React.MouseEvent, sessionId: string): void => {
    e.stopPropagation()
    setConfirmDeleteId(sessionId)
  }

  const handleConfirmDelete = (e: React.MouseEvent, sessionId: string): void => {
    e.stopPropagation()
    deleteSession(sessionId)
    setConfirmDeleteId(null)
  }

  const handleCancelDelete = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setConfirmDeleteId(null)
  }

  const handleDoubleClickTitle = (e: React.MouseEvent, sessionId: string, currentTitle: string): void => {
    e.stopPropagation()
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

  return (
    <div className="session-list">
      {sessions.length === 0 ? (
        <div className="session-list-empty">
          <p>No previous sessions</p>
          <p>Start a conversation to create one</p>
        </div>
      ) : (
        sessions.map((session) => (
          <div
            key={session.id}
            className={`session-item${session.id === conversationId ? ' active' : ''}`}
            onClick={() => {
              if (confirmDeleteId !== session.id && editingSessionId !== session.id) {
                handleSelectSession(session.id)
              }
            }}
          >
            {confirmDeleteId === session.id ? (
              <div className="session-item-confirm">
                <span>Delete this session? This cannot be undone.</span>
                <button
                  className="permission-btn permission-btn-deny"
                  onClick={(e) => handleConfirmDelete(e, session.id)}
                >
                  Delete
                </button>
                <button
                  className="permission-btn"
                  onClick={handleCancelDelete}
                >
                  Cancel
                </button>
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
                      onDoubleClick={(e) => handleDoubleClickTitle(e, session.id, session.title)}
                      title="Double-click to rename"
                    >
                      {session.title}
                    </div>
                  )}
                  <div className="session-item-time">{formatRelativeTime(session.updatedAt)}</div>
                </div>
                {editingSessionId !== session.id && (
                  <button
                    className="session-item-delete"
                    onClick={(e) => handleDeleteClick(e, session.id)}
                    title="Delete session"
                  >
                    x
                  </button>
                )}
              </>
            )}
          </div>
        ))
      )}
    </div>
  )
}
