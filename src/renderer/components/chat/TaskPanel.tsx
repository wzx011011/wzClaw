import React from 'react'
import { useTaskStore, getTaskCompletedCount } from '../../stores/task-store'
import type { AgentTask } from '../../../shared/types'

// ============================================================
// TaskPanel — displays agent task list with status badges
// (per TASK-01 through TASK-05)
// ============================================================

interface TaskPanelProps {
  onClose: () => void
}

// Status badge configuration
const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'task-status-pending' },
  in_progress: { label: 'In Progress', className: 'task-status-in_progress' },
  completed: { label: 'Done', className: 'task-status-completed' },
  blocked: { label: 'Blocked', className: 'task-status-blocked' }
}

function TaskItem({ task }: { task: AgentTask }): JSX.Element {
  const config = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.pending
  const isCompleted = task.status === 'completed'

  // Build tooltip for blocked tasks showing blocker subjects
  const blockerTooltip = (() => {
    if (task.status !== 'blocked' || task.blockedBy.length === 0) return undefined
    const tasks = useTaskStore.getState().tasks
    const blockerTitles = task.blockedBy
      .map((id) => {
        const blocker = tasks.find((t) => t.id === id)
        return blocker ? `${blocker.subject} (${id})` : id
      })
      .join(', ')
    return `Blocked by: ${blockerTitles}`
  })()

  return (
    <div className={`task-item${isCompleted ? ' completed' : ''}`} role="listitem">
      <div className="task-item-header">
        <span
          className={`task-status ${config.className}`}
          aria-label={`Status: ${task.status}`}
          title={blockerTooltip}
        >
          {task.status === 'in_progress' && (
            <span className="tool-status-icon" />
          )}
          {config.label}
        </span>
        <span className="task-item-title">{task.subject}</span>
      </div>
      {task.description && (
        <div className="task-item-description">{task.description}</div>
      )}
    </div>
  )
}

export default function TaskPanel({ onClose }: TaskPanelProps): JSX.Element {
  const tasks = useTaskStore((s) => s.tasks)
  const completedCount = getTaskCompletedCount(tasks)
  const totalCount = tasks.length
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0

  return (
    <div className="task-panel">
      <div className="task-panel-header">
        <span className="task-panel-title">TASKS</span>
        <span className="task-progress-text">{completedCount}/{totalCount} completed</span>
        <button className="task-panel-close" onClick={onClose} aria-label="Close task panel">
          x
        </button>
      </div>
      <div className="task-progress-bar">
        <div
          className="task-progress-fill"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
      {tasks.length === 0 ? (
        <div className="task-empty">
          <div>No tasks yet</div>
          <div>Tasks will appear here when the agent creates them during multi-step work</div>
        </div>
      ) : (
        <div className="task-list" role="list">
          {tasks.map((task) => (
            <TaskItem key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  )
}
