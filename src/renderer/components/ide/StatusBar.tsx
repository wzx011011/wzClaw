import React from 'react'
import { useTabStore } from '../../stores/tab-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useTerminalStore } from '../../stores/terminal-store'

/**
 * StatusBar -- bottom status bar showing file path, dirty state, encoding, and agent status (per D-55).
 * Shows active terminal name when terminal panel is visible.
 */
export default function StatusBar(): JSX.Element {
  const activeTab = useTabStore((s) => s.getActiveTab())
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const panelVisible = useTerminalStore((s) => s.panelVisible)
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId)
  const tabs = useTerminalStore((s) => s.tabs)

  // Build display path -- show full path for active file, or workspace root, or placeholder
  const displayPath = activeTab
    ? activeTab.filePath
    : rootPath ?? 'wzxClaw'

  // Find active terminal title for status bar display
  const activeTerminal = panelVisible && activeTerminalId
    ? tabs.find((t) => t.id === activeTerminalId)
    : null

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span className="status-item">{displayPath}</span>
        {activeTab?.isDirty && (
          <span className="status-item status-dirty">Modified</span>
        )}
      </div>
      <div className="status-bar-center">
        <span className="status-item">UTF-8</span>
      </div>
      <div className="status-bar-right">
        {activeTerminal && (
          <span className="status-item">Terminal: {activeTerminal.title}</span>
        )}
        <span className="status-item">Agent: Ready</span>
      </div>
    </div>
  )
}
