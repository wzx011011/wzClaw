import React from 'react'
import { useTabStore } from '../../stores/tab-store'
import { useWorkspaceStore } from '../../stores/workspace-store'

/**
 * StatusBar — bottom status bar showing file path, encoding, and agent status (per D-55).
 */
export default function StatusBar(): JSX.Element {
  const activeTab = useTabStore((s) => s.getActiveTab())
  const rootPath = useWorkspaceStore((s) => s.rootPath)

  const displayPath = activeTab
    ? activeTab.filePath
    : rootPath ?? 'No folder opened'

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span className="status-item">{displayPath}</span>
      </div>
      <div className="status-bar-center">
        <span className="status-item">UTF-8</span>
      </div>
      <div className="status-bar-right">
        <span className="status-item">Ready</span>
      </div>
    </div>
  )
}
