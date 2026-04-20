import React from 'react'
import { useStepStore, getStepCompletedCount } from '../../stores/step-store'
import type { AgentStep } from '../../../shared/types'

// ============================================================
// StepPanel — displays agent step list with status badges
// (per TASK-01 through TASK-05)
// ============================================================

interface StepPanelProps {
  onClose: () => void
}

// Status badge configuration
const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'task-status-pending' },
  in_progress: { label: 'In Progress', className: 'task-status-in_progress' },
  completed: { label: 'Done', className: 'task-status-completed' },
  blocked: { label: 'Blocked', className: 'task-status-blocked' }
}

function StepItem({ step }: { step: AgentStep }): JSX.Element {
  const config = STATUS_CONFIG[step.status] ?? STATUS_CONFIG.pending
  const isCompleted = step.status === 'completed'

  // Build tooltip for blocked steps showing blocker subjects
  const blockerTooltip = (() => {
    if (step.status !== 'blocked' || step.blockedBy.length === 0) return undefined
    const steps = useStepStore.getState().steps
    const blockerTitles = step.blockedBy
      .map((id) => {
        const blocker = steps.find((t) => t.id === id)
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
          aria-label={`Status: ${step.status}`}
          title={blockerTooltip}
        >
          {step.status === 'in_progress' && (
            <span className="tool-status-icon" />
          )}
          {config.label}
        </span>
        <span className="task-item-title">{step.subject}</span>
      </div>
      {step.description && (
        <div className="task-item-description">{step.description}</div>
      )}
    </div>
  )
}

export default function StepPanel({ onClose }: StepPanelProps): JSX.Element {
  const steps = useStepStore((s) => s.steps)
  const completedCount = getStepCompletedCount(steps)
  const totalCount = steps.length
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0

  return (
    <div className="task-panel">
      <div className="task-panel-header">
        <span className="task-panel-title">STEPS</span>
        <span className="task-progress-text">{completedCount}/{totalCount} completed</span>
        <button className="task-panel-close" onClick={onClose} aria-label="Close step panel">
          x
        </button>
      </div>
      <div className="task-progress-bar">
        <div
          className="task-progress-fill"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
      {steps.length === 0 ? (
        <div className="task-empty">
          <div>No steps yet</div>
          <div>Steps will appear here when the agent creates them during multi-step work</div>
        </div>
      ) : (
        <div className="task-list" role="list">
          {steps.map((step) => (
            <StepItem key={step.id} step={step} />
          ))}
        </div>
      )}
    </div>
  )
}
