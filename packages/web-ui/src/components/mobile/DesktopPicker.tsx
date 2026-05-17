// ============================================================
// DesktopPicker — 多 Hand 选择器
//
// 当 2+ Hands 在线时，显示选择卡片。
// 支持选择指定 Hand 或 "自动选择"（优先级路由）。
// ============================================================

import React from 'react'
import { useHandStore } from '../../stores/hand-store'

interface DesktopPickerProps {
  open: boolean
  onClose: () => void
}

export default function DesktopPicker({ open, onClose }: DesktopPickerProps): React.ReactElement | null {
  const { hands, selectedHandId, selectHand } = useHandStore()

  if (!open) return null

  return (
    <div
      className="mobile-sidebar-overlay"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          bottom: '60px',
          left: 'var(--sp-3)',
          right: 'var(--sp-3)',
          background: 'var(--bg-elevated)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          padding: 'var(--sp-3)',
          zIndex: 102,
          maxHeight: '60vh',
          overflowY: 'auto',
        }}
      >
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--sp-2)',
        }}>
          <span style={{ fontWeight: 600, fontSize: 'var(--font-size-sm)' }}>选择执行端</span>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '18px',
              lineHeight: 1,
              padding: '2px 6px',
            }}
          >
            &times;
          </button>
        </div>

        {/* 自动选择 */}
        <button
          onClick={() => { selectHand(null); onClose() }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sp-2)',
            width: '100%',
            padding: 'var(--sp-2) var(--sp-3)',
            background: selectedHandId === null ? 'var(--bg-tertiary)' : 'transparent',
            border: selectedHandId === null ? '2px solid var(--accent)' : '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            marginBottom: 'var(--sp-2)',
            touchAction: 'manipulation',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span style={{ fontSize: 'var(--font-size-sm)' }}>自动选择</span>
        </button>

        {/* Hand 列表 */}
        {hands.map((hand) => {
          const isSelected = selectedHandId === hand.id
          const isDocker = hand.type === 'docker'
          return (
            <button
              key={hand.id}
              onClick={() => { selectHand(hand.id); onClose() }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--sp-2)',
                width: '100%',
                padding: 'var(--sp-2) var(--sp-3)',
                background: isSelected ? 'var(--bg-tertiary)' : 'transparent',
                border: isSelected ? '2px solid var(--accent)' : '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                marginBottom: 'var(--sp-2)',
                touchAction: 'manipulation',
              }}
            >
              {isDocker ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 12s-3-3-7-3-7 3-7 3 3 3 7 3 7-3 7-3z" />
                  <path d="M5 12h14" />
                  <path d="M12 5v14" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
              )}
              <div style={{ flex: 1, textAlign: 'left' as const }}>
                <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 500 }}>{hand.id}</div>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                  {hand.type} · {hand.capabilities.length} 工具
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
