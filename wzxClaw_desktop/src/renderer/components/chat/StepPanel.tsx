import React from 'react'
import { useT } from '../../i18n/useT'
import { useStepStore } from '../../stores/step-store'
import type { AgentStep } from '../../../shared/types'

// ============================================================
// StepPanel — displays agent step list with status badges
// (per TASK-01 through TASK-05)
// ============================================================

interface StepPanelProps {
  onClose: () => void
}

// Status badge class names (labels resolved at render time via i18n)
const STATUS_CLASS: Record<string, string> = {
  pending: 'task-status-pending',
  in_progress: 'task-status-in_progress',
  completed: 'task-status-completed',
  blocked: 'task-status-blocked'
}

function StepItem({ step }: { step: AgentStep }): JSX.Element {
  const t = useT()
  const statusLabel: Record<string, string> = {
    pending: t('stepPanel.pending'),
    in_progress: t('stepPanel.inProgress'),
    completed: t('stepPanel.completed'),
    blocked: t('stepPanel.blocked'),
  }
  const config = { label: statusLabel[step.status] ?? t('stepPanel.pending'), className: STATUS_CLASS[step.status] ?? STATUS_CLASS.pending }
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
    return t('stepPanel.blockedBy', { blockers: blockerTitles })
  })()

  return (
    <div className={`task-item${isCompleted ? ' completed' : ''}`} role="listitem">
      <div className="workspace-item-header">
        <span
          className={`task-status ${config.className}`}
          aria-label={t('stepPanel.statusLabel', { status: step.status })}
          title={blockerTooltip}
        >
          {step.status === 'in_progress' && (
            <span className="tool-status-icon" />
          )}
          {config.label}
        </span>
        <span className="workspace-item-title">{step.subject}</span>
      </div>
      {step.description && (
        <div className="workspace-item-description">{step.description}</div>
      )}
    </div>
  )
}

export default function StepPanel({ onClose }: StepPanelProps): JSX.Element {
  const steps = useStepStore((s) => s.steps)
  const t = useT()

  return (
    <div className="workspace-panel">
      <div className="workspace-panel-header">
        <span className="workspace-panel-title">{t('stepPanel.steps')}</span>
        <button className="workspace-panel-close" onClick={onClose} aria-label={t('common.close')}>
          x
        </button>
      </div>
      {steps.length === 0 ? (
        <div className="workspace-empty">
          <div>{t('stepPanel.noSteps')}</div>
          <div>{t('stepPanel.hint')}</div>
        </div>
      ) : (
        <div className="workspace-list" role="list">
          {steps.map((step) => (
            <StepItem key={step.id} step={step} />
          ))}
        </div>
      )}
    </div>
  )
}
