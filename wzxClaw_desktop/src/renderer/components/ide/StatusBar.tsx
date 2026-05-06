import React, { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useTerminalStore } from '../../stores/terminal-store'
import { useIndexStore } from '../../stores/index-store'
import { useChatStore } from '../../stores/chat-store'
import { useT } from '../../i18n/useT'

interface RelayStatus {
  connected: boolean; connecting: boolean; reconnectAttempt: number
  mobileConnected: boolean; mobileIdentity: string | null
  mobiles: Array<{ deviceId: string; name: string | null; platform: string | null; osVersion: string | null; appVersion: string | null; connectedAt: number }>
}

interface UsageDisplay {
  totalCostUSD: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  model: string
}

/**
 * StatusBar -- bottom status bar showing workspace path, agent status,
 * terminal info, index status, relay connection status, and cost (Phase 4.4).
 */
export default function StatusBar(): JSX.Element {
  const t = useT()
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const panelVisible = useTerminalStore((s) => s.panelVisible)
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId)
  const tabs = useTerminalStore((s) => s.tabs)
  const indexStatus = useIndexStore((s) => s.status)
  const indexFileCount = useIndexStore((s) => s.fileCount)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null)
  const [usage, setUsage] = useState<UsageDisplay | null>(null)

  useEffect(() => {
    // Fetch initial relay status (events may have fired before mount)
    window.wzxclaw.getRelayStatus().then((status: RelayStatus) => {
      console.log('[StatusBar] initial relay status:', JSON.stringify(status))
      if (status) setRelayStatus(status)
    }).catch((err) => console.error('[StatusBar] getRelayStatus error:', err))
    // Subscribe to relay status updates
    const unsubRelay = window.wzxclaw.onRelayStatus((status) => {
      console.log('[StatusBar] relay status event:', JSON.stringify(status))
      setRelayStatus(status)
    })
    // Subscribe to usage/cost updates (Phase 4.4)
    const unsubUsage = window.wzxclaw.onUsageUpdate?.((payload) => {
      setUsage(payload)
    }) ?? (() => {})
    return () => {
      unsubRelay()
      unsubUsage()
    }
  }, [])

  const displayPath = rootPath ?? t('statusBar.noFolder')

  const activeTerminal = panelVisible && activeTerminalId
    ? tabs.find((t) => t.id === activeTerminalId)
    : null

  // Format cost display: "$0.0012 | 4.5K tok"
  const formatUsage = (u: UsageDisplay): string => {
    const total = u.inputTokens + u.outputTokens
    const tokStr = total >= 1000 ? `${(total / 1000).toFixed(1)}K tok` : `${total} tok`
    return `$${u.totalCostUSD.toFixed(4)} | ${tokStr}`
  }

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span className="status-item">{displayPath}</span>
      </div>
      <div className="status-bar-center" />
      <div className="status-bar-right">
        {activeTerminal && (
          <span className="status-item">{t('statusBar.terminal', { title: activeTerminal.title })}</span>
        )}
        <span className="status-item status-index">
          {indexStatus === 'indexing' && (
            <span title={t('statusBar.indexingTooltip')}>
              {t('statusBar.indexing', { count: indexFileCount })}
            </span>
          )}
          {indexStatus === 'ready' && (
            <span title={t('statusBar.indexedTooltip', { count: indexFileCount })}>
              {t('statusBar.indexed', { count: indexFileCount })}
            </span>
          )}
          {indexStatus === 'error' && (
            <span className="index-error" title={t('statusBar.indexErrorTooltip')}>
              ! {t('statusBar.indexError')}
            </span>
          )}
        </span>
        {/* Cost / token usage display (Phase 4.4) */}
        {usage && (
          <span
            className="status-item status-cost"
            title={t('statusBar.costTooltip', { model: usage.model, input: usage.inputTokens.toLocaleString(), output: usage.outputTokens.toLocaleString(), cacheRead: usage.cacheReadTokens.toLocaleString(), cacheWrite: usage.cacheWriteTokens.toLocaleString() })}
          >
            {formatUsage(usage)}
          </span>
        )}
        <span className="status-item">
          {isStreaming ? t('statusBar.agentWorking') : t('statusBar.agentReady')}
        </span>
        {relayStatus && relayStatus.connected && (
          <span className="status-item status-relay" title={relayStatus.mobileConnected ? t('statusBar.mobileConnectedTooltip', { identity: relayStatus.mobileIdentity ?? 'Mobile' }) : t('statusBar.relayConnectedTooltip')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
              <line x1="12" y1="18" x2="12.01" y2="18" />
            </svg>
            <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: relayStatus.mobileConnected ? 'var(--success)' : 'var(--warning)', display: 'inline-block', marginRight: 'var(--sp-1)' }} />
            {relayStatus.mobileConnected
              ? <span style={{ color: 'var(--success)', fontSize: 'var(--font-size-xs)' }}>{t('statusBar.mobileConnected', { identity: relayStatus.mobileIdentity ?? 'Mobile' })}</span>
              : <span style={{ color: 'var(--warning)', fontSize: 'var(--font-size-xs)' }}>{t('statusBar.relayWaiting')}</span>}
          </span>
        )}
      </div>
    </div>
  )
}
