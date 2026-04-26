import React from 'react'
import { useToastStore } from '../stores/toast-store'

// ============================================================
// Toast — 全局轻提示组件（Phase C）
// 固定于界面右下角，3 秒后自动消失
// ============================================================

const TYPE_STYLES: Record<string, { borderColor: string; iconColor: string; icon: string }> = {
  error: { borderColor: 'var(--error)', iconColor: 'var(--error)', icon: '✕' },
  success: { borderColor: 'var(--success)', iconColor: 'var(--success)', icon: '✓' },
  info: { borderColor: 'var(--accent)', iconColor: 'var(--accent)', icon: 'ℹ' },
}

export default function Toast(): JSX.Element | null {
  const message = useToastStore((s) => s.message)
  const type = useToastStore((s) => s.type)
  const clear = useToastStore((s) => s.clear)

  if (!message) return null

  const style = TYPE_STYLES[type] ?? TYPE_STYLES.info

  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 40,
        right: 16,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        padding: 'var(--sp-2) var(--sp-3)',
        background: 'var(--bg-elevated)',
        border: `1px solid ${style.borderColor}`,
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        fontSize: 'var(--font-size-sm)',
        color: 'var(--text-primary)',
        maxWidth: 320,
        animation: 'toast-slide-in 0.15s ease',
      }}
    >
      <span style={{ color: style.iconColor, fontWeight: 700, flexShrink: 0 }}>{style.icon}</span>
      <span style={{ flex: 1, lineHeight: 1.4 }}>{message}</span>
      <button
        onClick={clear}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          padding: 0,
          fontSize: 'var(--font-size-sm)',
          lineHeight: 1,
          flexShrink: 0,
        }}
        aria-label="关闭提示"
      >
        ✕
      </button>
    </div>
  )
}
