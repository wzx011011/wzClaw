import React from 'react'
import { useTerminalStore } from '../../stores/terminal-store'

// ============================================================
// TerminalTabs — Tab bar for managing multiple terminal instances
// (per TERM-03)
// ============================================================

export default function TerminalTabs(): JSX.Element {
  const tabs = useTerminalStore((s) => s.tabs)
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId)
  const switchTerminal = useTerminalStore((s) => s.switchTerminal)
  const closeTerminal = useTerminalStore((s) => s.closeTerminal)
  const createTerminal = useTerminalStore((s) => s.createTerminal)

  return (
    <div className="terminal-tabs-bar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`terminal-tab${tab.id === activeTerminalId ? ' terminal-tab-active' : ''}`}
          onClick={() => switchTerminal(tab.id)}
        >
          <span className="terminal-tab-title">{tab.title}</span>
          <button
            className="terminal-tab-close"
            onClick={(e) => {
              e.stopPropagation()
              closeTerminal(tab.id)
            }}
            title="Close terminal"
          >
            {'\u00D7'}
          </button>
        </div>
      ))}
      <button
        className="terminal-tab-new"
        onClick={() => createTerminal()}
        title="New terminal (Ctrl+Shift+`)"
      >
        +
      </button>
    </div>
  )
}
