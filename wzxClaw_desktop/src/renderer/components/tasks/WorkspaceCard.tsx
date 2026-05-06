import React, { useEffect, useState } from 'react'
import type { Workspace } from '../../../shared/types'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useT } from '../../i18n/useT'
import { formatRelativeTime } from '../../i18n/formatRelativeTime'

interface WorkspaceCardProps {
  workspace: Workspace
  onOpen: (workspaceId: string) => void
  onArchive: (workspaceId: string) => void
  onDelete: (workspaceId: string) => void
  onRename: (workspaceId: string, newTitle: string) => void
}

export default function WorkspaceCard({ workspace, onOpen, onArchive, onDelete, onRename }: WorkspaceCardProps): JSX.Element {
  const t = useT()
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(workspace.title)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const timeAgo = formatRelativeTime(workspace.updatedAt)
  const sessions = useWorkspaceStore((s) => s.workspaceSessions[workspace.id])

  // Load sessions when card mounts
  useEffect(() => {
    useWorkspaceStore.getState().loadWorkspaceSessions(workspace.id)
  }, [workspace.id])

  // 内联确认 5 秒后自动取消，防止误点后遗留状态
  useEffect(() => {
    if (!confirmingDelete) return
    const t = window.setTimeout(() => setConfirmingDelete(false), 5000)
    return () => window.clearTimeout(t)
  }, [confirmingDelete])

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== workspace.title) {
      onRename(workspace.id, trimmed)
    }
    setIsRenaming(false)
  }

  return (
    <div
      className="workspace-card"
      role="button"
      tabIndex={0}
      onClick={() => { if (!isRenaming) onOpen(workspace.id) }}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !isRenaming) { e.preventDefault(); onOpen(workspace.id) } }}
    >
      <div className="workspace-card-header">
        {isRenaming ? (
          <input
            className="workspace-card-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameSubmit()
              if (e.key === 'Escape') { setIsRenaming(false); setRenameValue(workspace.title) }
            }}
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <h3 className="workspace-card-title">{workspace.title}</h3>
        )}
        <div className="workspace-card-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {!isRenaming && (
            <button
              className="workspace-card-btn"
              title={t('common.rename')}
              onClick={() => setIsRenaming(true)}
            >
              ✎
            </button>
          )}
          <button
            className="workspace-card-btn"
            title={workspace.archived ? t('workspaceCard.unarchive') : t('workspaceCard.archive')}
            onClick={() => onArchive(workspace.id)}
          >
            {workspace.archived ? '↩' : '📦'}
          </button>
          {confirmingDelete ? (
            <>
              <button
                className="workspace-card-btn workspace-card-btn-danger"
                title={t('workspaceCard.confirmDelete')}
                onClick={() => { onDelete(workspace.id); setConfirmingDelete(false) }}
              >
                ✓
              </button>
              <button
                className="workspace-card-btn"
                title={t('workspaceCard.cancel')}
                onClick={() => setConfirmingDelete(false)}
              >
                ↩
              </button>
            </>
          ) : (
            <button
              className="workspace-card-btn workspace-card-btn-danger"
              title={t('common.delete')}
              onClick={() => setConfirmingDelete(true)}
            >
              ✕
            </button>
          )}
        </div>
      </div>
      {workspace.description && (
        <p className="workspace-card-desc">{workspace.description}</p>
      )}
      {workspace.projects.length > 0 && (
        <ul className="workspace-card-folders">
          {workspace.projects.map((p) => (
            <li key={p.id} className="workspace-card-folder-item" title={p.path}>
              <span className="workspace-card-folder-icon">📁</span>
              <span className="workspace-card-folder-name">{p.name}</span>
              <span className="workspace-card-folder-path">{shortenPath(p.path)}</span>
            </li>
          ))}
        </ul>
      )}
      {/* Session list with task status */}
      {sessions && sessions.length > 0 && (
        <ul className="workspace-card-sessions">
          {sessions.slice(0, 5).map((session) => (
            <li key={session.id} className="workspace-card-session-item">
              <span className={`workspace-card-session-dot${session.isRunning ? ' running' : ''}`} />
              <span className="workspace-card-session-title">{session.title || session.preview || '新会话'}</span>
              {session.todoSummary && (
                <span className="workspace-card-session-todo">{session.todoSummary}</span>
              )}
            </li>
          ))}
          {sessions.length > 5 && (
            <li className="workspace-card-session-more">
              +{sessions.length - 5} 更多会话
            </li>
          )}
        </ul>
      )}
      <div className="workspace-card-meta">
        {workspace.projects.length === 0 && (
          <span className="workspace-card-no-folder">{t('workspace.noFolder')}</span>
        )}
        <span className="workspace-card-time">{timeAgo}</span>
      </div>
    </div>
  )
}

/** Show up to the last 2 path segments to keep the UI compact */
function shortenPath(fullPath: string): string {
  const sep = fullPath.includes('\\') ? '\\' : '/'
  const parts = fullPath.split(sep).filter(Boolean)
  if (parts.length <= 2) return fullPath
  return '…' + sep + parts.slice(-2).join(sep)
}
