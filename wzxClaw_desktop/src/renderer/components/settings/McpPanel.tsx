import { useState, useEffect, useCallback } from 'react'
import { useT } from '../../i18n/useT'

// ============================================================
// McpPanel — MCP server management
// ============================================================

interface McpServerInfo {
  name: string
  transport: string
  connected: boolean
}

interface McpToolInfo {
  name: string
  description: string
  serverName: string
}

export default function McpPanel(): JSX.Element {
  const t = useT()
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [tools, setTools] = useState<McpToolInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [serverList, toolList] = await Promise.all([
        window.wzxclaw.listMcpServers?.() ?? [],
        window.wzxclaw.listMcpTools?.() ?? [],
      ])
      setServers(serverList)
      setTools(toolList)
    } catch (err) {
      console.error('[McpPanel] Failed to load MCP data:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const filteredTools = search
    ? tools.filter(t =>
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        t.serverName.toLowerCase().includes(search.toLowerCase())
      )
    : tools

  return (
    <div className="settings-panel">
      <div className="settings-panel-header">
        <h2 className="settings-panel-title">{t('settings.mcp.title')}</h2>
        <span className="settings-panel-subtitle">{t('settings.mcp.subtitle', { serverCount: servers.length, toolCount: tools.length })}</span>
      </div>

      <div className="settings-panel-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="settings-panel-search-input"
          placeholder={t('settings.mcp.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="settings-panel-body">
        {loading ? (
          <div className="settings-panel-empty">{t('settings.mcp.loading')}</div>
        ) : servers.length === 0 ? (
          <div className="settings-panel-empty">
            <p>{t('settings.mcp.noServers')}</p>
            <p className="settings-panel-hint" dangerouslySetInnerHTML={{ __html: t('settings.mcp.hint') }} />
          </div>
        ) : (
          <>
            <div className="settings-section">
              <div className="settings-section-title">{t('settings.mcp.servers')}</div>
              {servers.map(server => (
                <div key={server.name} className="settings-card flat">
                  <div className="settings-card-row">
                    <div className="settings-card-icon"><span>🔌</span></div>
                    <div className="settings-card-info">
                      <div className="settings-card-name">{server.name}</div>
                      <div className="settings-card-desc">{server.transport}</div>
                    </div>
                    <span className={`settings-badge ${server.connected ? 'success' : 'error'}`}>
                      {server.connected ? t('settings.mcp.connected') : t('settings.mcp.disconnected')}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {filteredTools.length > 0 && (
              <div className="settings-section">
                <div className="settings-section-title">{t('settings.mcp.availableTools', { count: filteredTools.length })}</div>
                {filteredTools.map(tool => (
                  <div key={`${tool.serverName}:${tool.name}`} className="settings-card flat">
                    <div className="settings-card-row">
                      <div className="settings-card-icon"><span>🔧</span></div>
                      <div className="settings-card-info">
                        <div className="settings-card-name">{tool.name}</div>
                        <div className="settings-card-desc">{tool.description || t('settings.mcp.noDescription')}</div>
                      </div>
                      <span className="settings-badge muted">{tool.serverName}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
