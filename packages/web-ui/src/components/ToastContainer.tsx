// ============================================================
// ToastContainer — Toast 通知 UI
//
// 显示 toast-store 中的通知队列，固定在右下角。
// 使用 CSS transition 做进入/退出动画（无 framer-motion 依赖）。
// ============================================================

import React, { useEffect, useState } from 'react'
import { useToastStore, type Toast } from '../stores/toast-store'

// ---- 单条 Toast ----

interface ToastItemProps {
  toast: Toast
  onDismiss: (id: string) => void
}

function ToastItem({ toast, onDismiss }: ToastItemProps): React.ReactElement {
  const [visible, setVisible] = useState(false)

  // 进入动画
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const colorMap: Record<Toast['type'], string> = {
    info:    'var(--accent, #7b6ef6)',
    success: 'var(--tool-completed, #22c55e)',
    warning: 'var(--warning, #f59e0b)',
    error:   'var(--tool-error, #ef4444)',
  }

  const iconMap: Record<Toast['type'], React.ReactElement> = {
    info: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    ),
    success: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ),
    warning: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
    error: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    ),
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '10px 14px',
        background: 'var(--bg-secondary, #2a2a3e)',
        border: `1px solid ${colorMap[toast.type]}40`,
        borderLeft: `3px solid ${colorMap[toast.type]}`,
        borderRadius: 'var(--radius-sm, 4px)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        minWidth: '240px',
        maxWidth: '400px',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateX(0)' : 'translateX(20px)',
        transition: 'opacity 200ms ease, transform 200ms ease',
        color: 'var(--text-primary, #e0e0e0)',
        fontSize: 'var(--font-size-sm, 12px)',
      }}
    >
      <span style={{ color: colorMap[toast.type], flexShrink: 0, marginTop: '1px' }}>
        {iconMap[toast.type]}
      </span>
      <span style={{ flex: 1, lineHeight: 1.5 }}>{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--text-secondary, #888)',
          cursor: 'pointer',
          padding: '0',
          flexShrink: 0,
          lineHeight: 1,
          marginTop: '1px',
        }}
        title="关闭"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  )
}

// ---- Toast 容器 ----

/**
 * ToastContainer — 应用根部挂载一次，渲染所有 toast
 */
export default function ToastContainer(): React.ReactElement {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  if (toasts.length === 0) return <></>

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        pointerEvents: 'none',
      }}
    >
      {toasts.map((toast) => (
        <div key={toast.id} style={{ pointerEvents: 'auto' }}>
          <ToastItem toast={toast} onDismiss={dismiss} />
        </div>
      ))}
    </div>
  )
}
