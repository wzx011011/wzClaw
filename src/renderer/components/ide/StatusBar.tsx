import React, { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useTerminalStore } from '../../stores/terminal-store'
import { useIndexStore } from '../../stores/index-store'
import { useChatStore } from '../../stores/chat-store'

interface RelayStatus {
  connected: boolean; connecting: boolean; reconnectAttempt: number
  mobileConnected: boolean; mobileIdentity: string | null
}

/**
 * StatusBar -- bottom status bar showing workspace path, agent status,
 * terminal info, index status, and relay connection status.
 */
export default function StatusBar(): JSX.Element {
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const panelVisible = useTerminalStore((s) => s.panelVisible)
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId)
  const tabs = useTerminalStore((s) => s.tabs)
  const indexStatus = useIndexStore((s) => s.status)
  const indexFileCount = useIndexStore((s) => s.fileCount)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null)

  useEffect(() => {
    // Fetch initial relay status (events may have fired before mount)
    window.wzxclaw.getRelayStatus().then((status: RelayStatus) => {
      console.log('[StatusBar] initial relay status:', JSON.stringify(status))
      if (status) setRelayStatus(status)
    }).catch((err) => console.error('[StatusBar] getRelayStatus error:', err))
    // Subscribe to relay status updates
    const unsub = window.wzxclaw.onRelayStatus((status) => {
      console.log('[StatusBar] relay status event:', JSON.stringify(status))
      setRelayStatus(status)
    })
    return unsub
  }, [])

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
        {relayStatus && relayStatus.connected && (
          <span className="status-item status-relay" title={relayStatus.mobileConnected ? `手机已连接: ${relayStatus.mobileIdentity ?? 'Mobile'}` : 'Relay 已连接，等待手机'}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
              <line x1="12" y1="18" x2="12.01" y2="18" />
            </svg>
            <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: relayStatus.mobileConnected ? '#4ade80' : '#fbbf24', display: 'inline-block', marginRight: 4 }} />
            {relayStatus.mobileConnected
              ? <span style={{ color: '#4ade80', fontSize: 11 }}>{relayStatus.mobileIdentity ?? 'Mobile'} 已连接</span>
              : <span style={{ color: '#fbbf24', fontSize: 11 }}>Relay 等待连接</span>}
          </span>
        )}
      </div>
    </div>
  )
}
