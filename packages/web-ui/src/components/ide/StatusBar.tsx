// ============================================================
// StatusBar — 底部状态栏
//
// 显示连接状态、终端信息、模型信息等。
// ============================================================

import React from 'react'
import { useConnectionState } from '../../providers/DataSourceProvider'
import { useTerminalStore } from '../../stores/terminal-store'

export default function StatusBar(): React.ReactElement {
  const connected = useConnectionState()
  const terminalCount = useTerminalStore((s) => s.terminals.length)

  return (
    <div style={{
      height: '22px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 8px',
      background: 'var(--bg-statusbar)',
      color: 'var(--text-on-statusbar)',
      fontSize: '11px',
      flexShrink: 0,
      userSelect: 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {/* 连接状态 */}
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: connected ? 'var(--status-connected)' : 'var(--status-disconnected)',
          }} />
          {connected ? '已连接' : '未连接'}
        </span>

        {/* 终端数量 */}
        {terminalCount > 0 && (
          <span>终端: {terminalCount}</span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span>wzxClaw</span>
      </div>
    </div>
  )
}
