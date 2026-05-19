// ============================================================
// TopBar — 移动端顶部栏
//
// 左：会话标题 | 右：连接状态 + 目标选择（多 Hand 时显示）
// 高度 44px，固定顶部
// ============================================================

import React from 'react'
import { useT } from '../../i18n/useT'

interface TopBarProps {
  title: string
  connected: boolean
  showPicker?: boolean
  onPickerOpen?: () => void
}

export default function TopBar({ title, connected, showPicker, onPickerOpen }: TopBarProps): React.ReactElement {
  const t = useT()

  return (
    <div className="mobile-top-bar">
      <div className="top-bar-left">
        <span className="top-bar-title">{title}</span>
      </div>
      <div className="top-bar-right">
        {/* Hand 选择按钮（2+ Hands 在线时显示） */}
        {showPicker && onPickerOpen && (
          <button
            onClick={onPickerOpen}
            title="选择执行端"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              touchAction: 'manipulation',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
            </svg>
          </button>
        )}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: 'var(--font-size-xs)',
            color: connected ? 'var(--tool-completed)' : 'var(--tool-error)',
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              backgroundColor: connected ? 'var(--status-connected)' : 'var(--status-disconnected)',
              display: 'inline-block',
            }}
          />
          {connected ? t('chat.connected') : t('chat.disconnected')}
        </span>
      </div>
    </div>
  )
}
