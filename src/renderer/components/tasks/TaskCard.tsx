import React from 'react'
import type { Task } from '../../../shared/types'

interface TaskCardProps {
  task: Task
  onOpen: (taskId: string) => void
  onArchive: (taskId: string) => void
  onDelete: (taskId: string) => void
}

export default function TaskCard({ task, onOpen, onArchive, onDelete }: TaskCardProps): JSX.Element {
  const projectCount = task.projects.length
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
      <div className="task-card-meta">
        <span className="task-card-projects">
          {projectCount === 0 ? '无项目' : `${projectCount} 个项目`}
        </span>
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
