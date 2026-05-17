// ============================================================
// TerminalTabs — 终端标签栏
//
// 终端实例切换、关闭、新建。
// ============================================================

import React from 'react'
import { useTerminalStore } from '../../stores/terminal-store'

export default function TerminalTabs(): React.ReactElement {
  const terminals = useTerminalStore((s) => s.terminals)
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId)
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal)
  const removeTerminal = useTerminalStore((s) => s.removeTerminal)

  if (terminals.length === 0) return <></>

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      height: '30px',
      background: 'var(--bg-primary)',
      borderBottom: '1px solid var(--border)',
      padding: '0 8px',
      gap: '2px',
    }}>
      {terminals.map((term) => {
        const isActive = term.id === activeTerminalId
        return (
          <div
            key={term.id}
            onClick={() => setActiveTerminal(term.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '2px 8px',
              fontSize: 'var(--font-size-xs)',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              background: isActive ? 'var(--bg-secondary)' : 'transparent',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            <span>{term.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                removeTerminal(term.id)
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                padding: '0',
                fontSize: '12px',
                lineHeight: 1,
              }}
            >
              x
            </button>
          </div>
        )
      })}
    </div>
  )
}
