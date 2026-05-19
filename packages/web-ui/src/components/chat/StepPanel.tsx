// ============================================================
// StepPanel — 计划模式步骤面板
//
// 展示 Agent 在 plan 模式下的结构化步骤列表。
// 从 step-store 读取状态，不接受外部 props。
// ============================================================

import React from 'react'
import { useStepStore, type Step, type StepStatus } from '../../stores/step-store'

const STATUS_ICONS: Record<StepStatus, React.ReactElement> = {
  pending: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
    </svg>
  ),
  running: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="spin">
      <path d="M21 12a9 9 0 11-18 0" />
    </svg>
  ),
  completed: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  failed: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  skipped: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="13 17 18 12 13 7" /><polyline points="6 17 11 12 6 7" />
    </svg>
  ),
}

const STATUS_COLORS: Record<StepStatus, string> = {
  pending:   'var(--text-muted, #666)',
  running:   'var(--accent, #7b6ef6)',
  completed: 'var(--tool-completed, #22c55e)',
  failed:    'var(--tool-error, #ef4444)',
  skipped:   'var(--text-muted, #666)',
}

interface StepItemProps {
  step: Step
}

function StepItem({ step }: StepItemProps): React.ReactElement {
  const color = STATUS_COLORS[step.status]
  const icon = STATUS_ICONS[step.status]

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
      padding: '8px 0',
      borderBottom: '1px solid var(--border-subtle, #2a2a3e)',
      opacity: step.status === 'skipped' ? 0.5 : 1,
    }}>
      {/* 步骤序号 + 图标 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexShrink: 0,
        color,
        minWidth: '40px',
      }}>
        <span style={{ fontSize: '11px', color: 'var(--text-muted, #666)' }}>{step.index}.</span>
        {icon}
      </div>

      {/* 步骤内容 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 'var(--font-size-sm, 12px)',
          color: step.status === 'running' ? color : 'var(--text-primary, #e0e0e0)',
          fontWeight: step.status === 'running' ? 600 : 400,
          lineHeight: 1.4,
        }}>
          {step.title}
        </div>
        {step.description && (
          <div style={{
            fontSize: '11px',
            color: 'var(--text-secondary, #888)',
            marginTop: '2px',
            lineHeight: 1.5,
          }}>
            {step.description}
          </div>
        )}
      </div>

      {/* 耗时（仅已完成步骤） */}
      {step.status === 'completed' && step.startedAt && step.completedAt && (
        <div style={{ fontSize: '10px', color: 'var(--text-muted, #666)', flexShrink: 0 }}>
          {((step.completedAt - step.startedAt) / 1000).toFixed(1)}s
        </div>
      )}
    </div>
  )
}

/** StepPanel — 计划步骤面板 */
export default function StepPanel(): React.ReactElement | null {
  const steps = useStepStore((s) => s.steps)
  const visible = useStepStore((s) => s.visible)
  const hide = useStepStore((s) => s.hide)

  if (!visible || steps.length === 0) return null

  const doneCount = steps.filter((s) => s.status === 'completed').length
  const total = steps.length

  return (
    <div style={{
      margin: '8px 12px',
      background: 'var(--bg-secondary, #2a2a3e)',
      border: '1px solid var(--border, #333)',
      borderRadius: 'var(--radius-sm, 4px)',
      overflow: 'hidden',
    }}>
      {/* 标题栏 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: '1px solid var(--border, #333)',
        background: 'var(--bg-primary, #1a1a2e)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #7b6ef6)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
          </svg>
          <span style={{ fontSize: 'var(--font-size-sm, 12px)', fontWeight: 600, color: 'var(--text-primary, #e0e0e0)' }}>
            执行计划
          </span>
          <span style={{ fontSize: '11px', color: 'var(--text-secondary, #888)' }}>
            {doneCount}/{total}
          </span>
        </div>
        <button
          onClick={hide}
          style={{ background: 'transparent', border: 'none', color: 'var(--text-muted, #666)', cursor: 'pointer', padding: '2px' }}
          title="收起"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>
      </div>

      {/* 步骤列表 */}
      <div style={{ padding: '4px 12px 8px', maxHeight: '240px', overflow: 'auto' }}>
        {steps.map((step) => (
          <StepItem key={step.id} step={step} />
        ))}
      </div>

      {/* 进度条 */}
      <div style={{ height: '2px', background: 'var(--border, #333)' }}>
        <div style={{
          height: '100%',
          width: `${(doneCount / total) * 100}%`,
          background: 'var(--accent, #7b6ef6)',
          transition: 'width 300ms ease',
        }} />
      </div>
    </div>
  )
}
