import React from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useTerminalStore } from '../../stores/terminal-store'
import { useIndexStore } from '../../stores/index-store'
import { useChatStore } from '../../stores/chat-store'

/**
 * StatusBar -- bottom status bar showing workspace path, agent status,
 * terminal info, and index status.
 */
export default function StatusBar(): JSX.Element {
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const panelVisible = useTerminalStore((s) => s.panelVisible)
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId)
  const tabs = useTerminalStore((s) => s.tabs)
  const indexStatus = useIndexStore((s) => s.status)
  const indexFileCount = useIndexStore((s) => s.fileCount)
  const isStreaming = useChatStore((s) => s.isStreaming)

  const displayPath = rootPath ?? 'No folder open'

  const activeTerminal = panelVisible && activeTerminalId
    ? tabs.find((t) => t.id === activeTerminalId)
    : null

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span className="status-item">{displayPath}</span>
      </div>
      <div className="status-bar-center" />
      <div className="status-bar-right">
        {activeTerminal && (
          <span className="status-item">Terminal: {activeTerminal.title}</span>
        )}
        <span className="status-item status-index">
          {indexStatus === 'indexing' && (
            <span title="Indexing codebase...">
              ~ Indexing... ({indexFileCount})
            </span>
          )}
          {indexStatus === 'ready' && (
            <span title={`Index ready: ${indexFileCount} files indexed`}>
              {indexFileCount} indexed
            </span>
          )}
          {indexStatus === 'error' && (
            <span className="index-error" title="Indexing error">
              ! Index Error
            </span>
          )}
        </span>
        <span className="status-item">
          {isStreaming ? 'Agent: Working...' : 'Agent: Ready'}
        </span>
      </div>
    </div>
  )
}
