import React from 'react'
import type { Task } from '../../../shared/types'

interface TaskCardProps {
  task: Task
  onOpen: (taskId: string) => void
  onArchive: (taskId: string) => void
  onDelete: (taskId: string) => void
}

export default function TaskCard({ task, onOpen, onArchive, onDelete }: TaskCardProps): JSX.Element {
  const timeAgo = formatTimeAgo(task.updatedAt)

  return (
    <div className="task-card" onClick={() => onOpen(task.id)}>
      <div className="task-card-header">
        <h3 className="task-card-title">{task.title}</h3>
        <div className="task-card-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="task-card-btn"
            title={task.archived ? '取消归档' : '归档'}
            onClick={() => onArchive(task.id)}
          >
            {task.archived ? '↩' : '📦'}
          </button>
          <button
            className="task-card-btn task-card-btn-danger"
            title="删除"
            onClick={() => onDelete(task.id)}
          >
            ✕
          </button>
        </div>
      </div>
      {task.description && (
        <p className="task-card-desc">{task.description}</p>
      )}
      {task.progressSummary && (
        <div className="task-card-progress">
          <span className="task-card-progress-icon">📊</span>
          <span className="task-card-progress-text">{task.progressSummary}</span>
        </div>
      )}
      {task.projects.length > 0 && (
        <ul className="task-card-folders">
          {task.projects.map((p) => (
            <li key={p.id} className="task-card-folder-item" title={p.path}>
              <span className="task-card-folder-icon">📁</span>
              <span className="task-card-folder-name">{p.name}</span>
              <span className="task-card-folder-path">{shortenPath(p.path)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="task-card-meta">
        {task.projects.length === 0 && (
          <span className="task-card-no-folder">无绑定文件夹</span>
        )}
        <span className="task-card-time">{timeAgo}</span>
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
