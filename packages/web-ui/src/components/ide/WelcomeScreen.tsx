// ============================================================
// WelcomeScreen — 编辑器空状态页面
//
// 无文件打开时显示，包含品牌标识和快捷键提示。
// ============================================================

import React from 'react'

export default function WelcomeScreen(): React.ReactElement {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      color: 'var(--text-secondary)',
      gap: 'var(--sp-3)',
      userSelect: 'none',
    }}>
      <div style={{
        fontSize: 'var(--font-size-2xl)',
        fontWeight: 700,
        color: 'var(--text-primary)',
        letterSpacing: '-0.02em',
      }}>
        wzxClaw
      </div>
      <div style={{
        fontSize: 'var(--font-size-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-1)',
        textAlign: 'center',
      }}>
        <span>Ctrl+K 命令面板</span>
        <span>Ctrl+B 切换侧边栏</span>
        <span>Ctrl+` 切换终端</span>
      </div>
    </div>
  )
}
