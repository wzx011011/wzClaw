import { useState, useEffect, useCallback } from 'react'
import { useT } from '../../i18n/useT'

// ============================================================
// ToolsPanel — List all registered agent tools with descriptions
// ============================================================

interface ToolInfo {
  name: string
  description: string
  isReadOnly: boolean
  requiresApproval: boolean
}

export default function ToolsPanel(): JSX.Element {
  const t = useT()
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const loadTools = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.wzxclaw.listTools?.() ?? []
      setTools(result)
    } catch (err) {
      console.error('[ToolsPanel] Failed to load tools:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadTools() }, [loadTools])

  const filtered = search
    ? tools.filter(t =>
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        t.description.toLowerCase().includes(search.toLowerCase())
      )
    : tools

  const readOnly = filtered.filter(t => t.isReadOnly)
  const writeTools = filtered.filter(t => !t.isReadOnly)

  return (
    <div className="settings-panel">
      <div className="settings-panel-header">
        <h2 className="settings-panel-title">{t('settings.tools.title')}</h2>
        <span className="settings-panel-subtitle">{t('settings.tools.subtitle', { count: tools.length })}</span>
      </div>

      <div className="settings-panel-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="settings-panel-search-input"
          placeholder={t('settings.tools.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="settings-panel-body">
        {loading ? (
          <div className="settings-panel-empty">{t('settings.tools.loading')}</div>
        ) : (
          <>
            {writeTools.length > 0 && (
              <div className="settings-section">
                <div className="settings-section-title">{t('settings.tools.writeTools', { count: writeTools.length })}</div>
                {writeTools.map(tool => (
                  <div key={tool.name} className="settings-card flat">
                    <div className="settings-card-row">
                      <div className="settings-card-icon"><span>✏️</span></div>
                      <div className="settings-card-info">
                        <div className="settings-card-name">{tool.name}</div>
                        <div className="settings-card-desc">{tool.description.split('\n')[0]}</div>
                      </div>
                      {tool.requiresApproval && <span className="settings-badge warning">{t('settings.tools.requiresApproval')}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {readOnly.length > 0 && (
              <div className="settings-section">
                <div className="settings-section-title">{t('settings.tools.readOnlyTools', { count: readOnly.length })}</div>
                {readOnly.map(tool => (
                  <div key={tool.name} className="settings-card flat">
                    <div className="settings-card-row">
                      <div className="settings-card-icon"><span>👁️</span></div>
                      <div className="settings-card-info">
                        <div className="settings-card-name">{tool.name}</div>
                        <div className="settings-card-desc">{tool.description.split('\n')[0]}</div>
                      </div>
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
