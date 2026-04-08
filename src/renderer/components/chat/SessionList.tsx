import React, { useState, useEffect } from 'react'
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
  const loadSession = useChatStore((s) => s.loadSession)
  const deleteSession = useChatStore((s) => s.deleteSession)

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // Auto-dismiss confirmation after 5 seconds
  useEffect(() => {
    if (!confirmDeleteId) return
    const timer = setTimeout(() => setConfirmDeleteId(null), 5000)
    return () => clearTimeout(timer)
  }, [confirmDeleteId])

  if (!isOpen) return null

  const handleSelectSession = (sessionId: string): void => {
    loadSession(sessionId)
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
              if (confirmDeleteId !== session.id) {
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
                  <div className="session-item-title">{session.title}</div>
                  <div className="session-item-time">{formatRelativeTime(session.updatedAt)}</div>
                </div>
                <button
                  className="session-item-delete"
                  onClick={(e) => handleDeleteClick(e, session.id)}
                  title="Delete session"
                >
                  x
                </button>
              </>
            )}
          </div>
        ))
      )}
    </div>
  )
}
