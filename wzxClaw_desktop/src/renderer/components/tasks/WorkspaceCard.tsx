import React, { useEffect, useState } from 'react'
import type { Workspace } from '../../../shared/types'

interface TaskCardProps {
  task: Workspace
  onOpen: (taskId: string) => void
  onArchive: (taskId: string) => void
  onDelete: (taskId: string) => void
  onRename: (taskId: string, newTitle: string) => void
}

export default function WorkspaceCard({ task, onOpen, onArchive, onDelete, onRename }: TaskCardProps): JSX.Element {
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(task.title)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const timeAgo = formatTimeAgo(task.updatedAt)

  // 内联确认 5 秒后自动取消，防止误点后遗留状态
  useEffect(() => {
    if (!confirmingDelete) return
    const t = window.setTimeout(() => setConfirmingDelete(false), 5000)
    return () => window.clearTimeout(t)
  }, [confirmingDelete])

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== task.title) {
      onRename(task.id, trimmed)
    }
    setIsRenaming(false)
  }

  return (
    <div
      className="workspace-card"
      role="button"
      tabIndex={0}
      onClick={() => { if (!isRenaming) onOpen(task.id) }}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !isRenaming) { e.preventDefault(); onOpen(task.id) } }}
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
              if (e.key === 'Escape') { setIsRenaming(false); setRenameValue(task.title) }
            }}
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <h3 className="workspace-card-title">{task.title}</h3>
        )}
        <div className="workspace-card-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {!isRenaming && (
            <button
              className="workspace-card-btn"
              title="重命名"
              onClick={() => setIsRenaming(true)}
            >
              ✎
            </button>
          )}
          <button
            className="workspace-card-btn"
            title={task.archived ? '取消归档' : '归档'}
            onClick={() => onArchive(task.id)}
          >
            {task.archived ? '↩' : '📦'}
          </button>
          {confirmingDelete ? (
            <>
              <button
                className="workspace-card-btn workspace-card-btn-danger"
                title="确认删除"
                onClick={() => { onDelete(task.id); setConfirmingDelete(false) }}
              >
                ✓
              </button>
              <button
                className="workspace-card-btn"
                title="取消"
                onClick={() => setConfirmingDelete(false)}
              >
                ↩
              </button>
            </>
          ) : (
            <button
              className="workspace-card-btn workspace-card-btn-danger"
              title="删除"
              onClick={() => setConfirmingDelete(true)}
            >
              ✕
            </button>
          )}
        </div>
      </div>
      {task.description && (
        <p className="workspace-card-desc">{task.description}</p>
      )}
      {task.progressSummary && (
        <div className="workspace-card-progress">
          <span className="workspace-card-progress-icon">📊</span>
          <span className="workspace-card-progress-text">{task.progressSummary}</span>
        </div>
      )}
      {task.projects.length > 0 && (
        <ul className="workspace-card-folders">
          {task.projects.map((p) => (
            <li key={p.id} className="workspace-card-folder-item" title={p.path}>
              <span className="workspace-card-folder-icon">📁</span>
              <span className="workspace-card-folder-name">{p.name}</span>
              <span className="workspace-card-folder-path">{shortenPath(p.path)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="workspace-card-meta">
        {task.projects.length === 0 && (
          <span className="workspace-card-no-folder">无绑定文件夹</span>
        )}
        <span className="workspace-card-time">{timeAgo}</span>
      </div>
    </div>
  )
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(timestamp).toLocaleDateString()
}

/** Show up to the last 2 path segments to keep the UI compact */
function shortenPath(fullPath: string): string {
  const sep = fullPath.includes('\\') ? '\\' : '/'
  const parts = fullPath.split(sep).filter(Boolean)
  if (parts.length <= 2) return fullPath
  return '…' + sep + parts.slice(-2).join(sep)
}
