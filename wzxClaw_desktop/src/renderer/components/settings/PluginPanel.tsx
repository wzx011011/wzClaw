import { useState, useEffect, useCallback } from 'react'
import type { PluginInfo, MarketplacePluginDisplay } from '../../../shared/types-plugin'
import { useT } from '../../i18n/useT'

// ============================================================
// PluginPanel — Plugin management panel for the settings page
// Tabs: 发现 (Discover) | 已安装 (Installed) | 市场 (Marketplace)
// ============================================================

type TabId = 'discover' | 'installed' | 'marketplace'

export default function PluginPanel(): JSX.Element {
  const t = useT()
  const [activeTab, setActiveTab] = useState<TabId>('discover')
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [marketplacePlugins, setMarketplacePlugins] = useState<MarketplacePluginDisplay[]>([])
  const [loading, setLoading] = useState(false)
  const [marketplaceLoading, setMarketplaceLoading] = useState(false)
  const [actionStatus, setActionStatus] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [installUrl, setInstallUrl] = useState('')
  const [installing, setInstalling] = useState<string | null>(null)
  const [showInstall, setShowInstall] = useState(false)
  const [configPlugin, setConfigPlugin] = useState<string | null>(null)
  const [configText, setConfigText] = useState('')
  const [pendingUninstall, setPendingUninstall] = useState<string | null>(null)
  const [configParseError, setConfigParseError] = useState<string | null>(null)

  const loadPlugins = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.wzxclaw.listPlugins()
      setPlugins(list)
    } catch (err) {
      console.error('[PluginPanel] Failed to load plugins:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMarketplace = useCallback(async () => {
    setMarketplaceLoading(true)
    try {
      const results = await window.wzxclaw.searchPluginMarketplace({ query: searchQuery })
      setMarketplacePlugins(results)
    } catch (err) {
      console.error('[PluginPanel] Failed to load marketplace:', err)
    } finally {
      setMarketplaceLoading(false)
    }
  }, [searchQuery])

  useEffect(() => {
    loadPlugins()
  }, [loadPlugins])

  useEffect(() => {
    if (activeTab === 'marketplace') {
      loadMarketplace()
    }
  }, [activeTab, loadMarketplace])

  const handleToggle = async (plugin: PluginInfo): Promise<void> => {
    const fn = plugin.enabled ? window.wzxclaw.disablePlugin : window.wzxclaw.enablePlugin
    setInstalling(plugin.name)
    try {
      const result = await fn({ name: plugin.name })
      setActionStatus(result.message)
      if (result.success) await loadPlugins()
    } finally {
      setInstalling(null)
      setTimeout(() => setActionStatus(null), 3000)
    }
  }

  const handleUninstall = async (plugin: PluginInfo): Promise<void> => {
    // 内联确认：首次点击显示确认，再次点击执行卸载
    if (pendingUninstall !== plugin.name) {
      setPendingUninstall(plugin.name)
      setTimeout(() => setPendingUninstall(null), 5000)
      return
    }
    setPendingUninstall(null)
    setInstalling(plugin.name)
    try {
      const result = await window.wzxclaw.uninstallPlugin({ name: plugin.name })
      setActionStatus(result.message)
      if (result.success) await loadPlugins()
    } finally {
      setInstalling(null)
      setTimeout(() => setActionStatus(null), 3000)
    }
  }

  const handleReload = async (): Promise<void> => {
    setLoading(true)
    await window.wzxclaw.reloadPlugins()
    await loadPlugins()
    setActionStatus(t('settings.plugins.reloaded'))
    setTimeout(() => setActionStatus(null), 3000)
  }

  const handleInstallFromUrl = async (): Promise<void> => {
    const url = installUrl.trim()
    if (!url) return
    setInstalling('__url__')
    try {
      const githubMatch = url.match(/^([\w-]+\/[\w.-]+)(?:#(.+))?$/)
      let source: { source: 'github' | 'git' | 'url'; repo?: string; url?: string; ref?: string }
      if (githubMatch) {
        source = { source: 'github', repo: githubMatch[1], ref: githubMatch[2] }
      } else if (url.endsWith('.git') || url.includes('github.com') || url.includes('gitlab.com')) {
        source = { source: 'git', url }
      } else {
        source = { source: 'url', url }
      }
      const result = await window.wzxclaw.installPluginFromSource({ source })
      setActionStatus(result.message)
      if (result.success) {
        setInstallUrl('')
        setShowInstall(false)
        await loadPlugins()
      }
    } catch (err) {
      setActionStatus(t('settings.plugins.installFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setInstalling(null)
      setTimeout(() => setActionStatus(null), 5000)
    }
  }

  const handleInstallFromMarketplace = async (plugin: MarketplacePluginDisplay): Promise<void> => {
    setInstalling(plugin.name)
    try {
      const result = await window.wzxclaw.installPluginFromSource({ source: plugin.installSource })
      setActionStatus(result.message)
      if (result.success) {
        await loadPlugins()
        await loadMarketplace()
      }
    } catch (err) {
      setActionStatus(t('settings.plugins.installFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setInstalling(null)
      setTimeout(() => setActionStatus(null), 5000)
    }
  }

  const handleOpenConfig = async (pluginName: string): Promise<void> => {
    try {
      const values = await window.wzxclaw.getPluginUserConfig({ pluginName })
      setConfigText(JSON.stringify(values, null, 2))
      setConfigParseError(null)
      setConfigPlugin(pluginName)
    } catch (err) {
      console.error('[PluginPanel] Failed to load config:', err)
    }
  }

  const handleSaveConfig = async (): Promise<void> => {
    if (!configPlugin) return
    if (configParseError) {
      setActionStatus(t('settings.plugins.cannotSave', { error: configParseError }))
      setTimeout(() => setActionStatus(null), 3000)
      return
    }
    try {
      const parsed = JSON.parse(configText)
      const result = await window.wzxclaw.setPluginUserConfig({
        pluginName: configPlugin,
        values: parsed,
      })
      setActionStatus(result.message)
      if (result.success) setConfigPlugin(null)
    } catch {
      setActionStatus(t('settings.plugins.cannotSave', { error: t('settings.plugins.invalidJson') }))
    }
    setTimeout(() => setActionStatus(null), 3000)
  }

  const getPluginTags = (plugin: PluginInfo): string[] => {
    const tags: string[] = []
    if (plugin.agentCount > 0) tags.push('Agent')
    if (plugin.commandCount > 0) tags.push('Command')
    if (plugin.skillCount > 0) tags.push('Skill')
    if (plugin.hasMcpServers) tags.push('MCP')
    if (plugin.hasHooks) tags.push('Hooks')
    return tags
  }

  const filteredPlugins = searchQuery
    ? plugins.filter(p =>
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (p.description?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
      )
    : plugins

  const discoverPlugins = [...filteredPlugins]

  return (
    <div className="settings-panel">
      <div className="settings-panel-header">
        <h2 className="settings-panel-title">{t('settings.plugins.title')}</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="settings-btn-secondary"
            onClick={() => setShowInstall(!showInstall)}
          >
            {t('settings.plugins.installFromUrl')}
          </button>
          <button className="settings-btn-secondary" onClick={handleReload} disabled={loading}>
            {loading ? t('settings.plugins.loading') : t('common.refresh')}
          </button>
        </div>
      </div>

      {actionStatus && (
        <div className="settings-panel-status">{actionStatus}</div>
      )}

      {showInstall && (
        <div className="settings-panel-install-bar">
          <input
            type="text"
            className="settings-input"
            placeholder={t('settings.plugins.installUrlPlaceholder')}
            value={installUrl}
            onChange={(e) => setInstallUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleInstallFromUrl() }}
            disabled={installing === '__url__'}
          />
          <button
            className="settings-btn-primary"
            onClick={handleInstallFromUrl}
            disabled={installing === '__url__' || !installUrl.trim()}
          >
            {installing === '__url__' ? t('settings.plugins.installing') : t('common.install')}
          </button>
        </div>
      )}

      {configPlugin && (
        <div className="settings-panel-config-overlay">
          <div className="settings-panel-config">
            <div className="settings-panel-config-header">
              <h3>{t('settings.plugins.configLabel', { name: configPlugin })}</h3>
              <button className="settings-close-btn" onClick={() => setConfigPlugin(null)}>✕</button>
            </div>
            <textarea
              className="settings-panel-config-editor"
              value={configText}
              onChange={(e) => {
                setConfigText(e.target.value)
                try {
                  JSON.parse(e.target.value)
                  setConfigParseError(null)
                } catch {
                  setConfigParseError(t('settings.plugins.invalidJson'))
                }
              }}
            />
            {configParseError && <div className="settings-panel-config-error">{configParseError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 8 }}>
              <button className="settings-btn-secondary" onClick={() => setConfigPlugin(null)}>{t('common.cancel')}</button>
              <button className="settings-btn-primary" onClick={handleSaveConfig}>{t('common.save')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Tab bar */}
      <div className="settings-panel-tabs">
        {(['discover', 'installed', 'marketplace'] as TabId[]).map(tab => (
          <button
            key={tab}
            className={`settings-panel-tab${activeTab === tab ? ' active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'discover' ? t('settings.plugins.discover') : tab === 'installed' ? t('settings.plugins.installed') : t('settings.plugins.marketplace')}
            {tab === 'installed' && plugins.length > 0 && (
              <span className="settings-panel-tab-count">{plugins.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Search bar */}
      <div className="settings-panel-search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="settings-panel-search-input"
          placeholder={t('settings.plugins.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Content */}
      <div className="settings-panel-body">
        {activeTab === 'discover' && (
          <div className="settings-panel-list">
            {loading && discoverPlugins.length === 0 ? (
              <div className="settings-panel-empty">{t('settings.plugins.loadingPlugins')}</div>
            ) : discoverPlugins.length === 0 ? (
              <div className="settings-panel-empty">
                <p>{t('settings.plugins.noPluginsFound')}</p>
                <p className="settings-panel-hint" dangerouslySetInnerHTML={{ __html: t('settings.plugins.discoverHint') }} />
              </div>
            ) : (
              discoverPlugins.map(plugin => (
                <div key={plugin.name} className={`settings-card ${plugin.enabled ? 'enabled' : 'disabled'}`}>
                  <div className="settings-card-row">
                    <div className="settings-card-icon">
                      <span>🧩</span>
                    </div>
                    <div className="settings-card-info">
                      <div className="settings-card-header">
                        <span className="settings-card-name">{plugin.name}</span>
                        {plugin.isBuiltin && <span className="settings-badge builtin">{t('settings.plugins.builtin')}</span>}
                        {plugin.version && <span className="settings-card-version">v{plugin.version}</span>}
                      </div>
                      {plugin.description && <div className="settings-card-desc">{plugin.description}</div>}
                      <div className="settings-card-tags">
                        {getPluginTags(plugin).map(tag => (
                          <span key={tag} className={`settings-tag settings-tag-${tag.toLowerCase()}`}>{tag}</span>
                        ))}
                      </div>
                    </div>
                    <div className="settings-card-actions">
                      {plugin.hasUserConfig && (
                        <button className="settings-btn-sm settings-btn-secondary" onClick={() => handleOpenConfig(plugin.name)}>{t('common.config')}</button>
                      )}
                      <button
                        className={`settings-btn-sm ${plugin.enabled ? 'settings-btn-warning' : 'settings-btn-primary'}`}
                        onClick={() => handleToggle(plugin)}
                        disabled={installing === plugin.name}
                      >
                        {installing === plugin.name ? '...' : plugin.enabled ? t('common.disable') : t('common.enable')}
                      </button>
                      {!plugin.isBuiltin && (
                        <button className="settings-btn-sm settings-btn-danger" onClick={() => handleUninstall(plugin)}>{pendingUninstall === plugin.name ? t('settings.plugins.confirmUninstall') : t('common.uninstall')}</button>
                      )}
                    </div>
                  </div>
                  {plugin.errors && plugin.errors.length > 0 && (
                    <div className="settings-card-errors">
                      {plugin.errors.map((e, i) => (
                        <div key={i} className="settings-card-error">{e.message}</div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'installed' && (
          <div className="settings-panel-list">
            {plugins.filter(p => !p.isBuiltin).length === 0 ? (
              <div className="settings-panel-empty">
                <p>{t('settings.plugins.noInstalledPlugins')}</p>
                <p className="settings-panel-hint">{t('settings.plugins.installedHint')}</p>
              </div>
            ) : (
              plugins.filter(p => !p.isBuiltin).map(plugin => (
                <div key={plugin.name} className={`settings-card ${plugin.enabled ? 'enabled' : 'disabled'}`}>
                  <div className="settings-card-row">
                    <div className="settings-card-icon"><span>🧩</span></div>
                    <div className="settings-card-info">
                      <div className="settings-card-header">
                        <span className="settings-card-name">{plugin.name}</span>
                        {plugin.version && <span className="settings-card-version">v{plugin.version}</span>}
                      </div>
                      {plugin.description && <div className="settings-card-desc">{plugin.description}</div>}
                      <div className="settings-card-tags">
                        {getPluginTags(plugin).map(tag => (
                          <span key={tag} className={`settings-tag settings-tag-${tag.toLowerCase()}`}>{tag}</span>
                        ))}
                      </div>
                    </div>
                    <div className="settings-card-actions">
                      {plugin.hasUserConfig && (
                        <button className="settings-btn-sm settings-btn-secondary" onClick={() => handleOpenConfig(plugin.name)}>{t('common.config')}</button>
                      )}
                      <button
                        className={`settings-btn-sm ${plugin.enabled ? 'settings-btn-warning' : 'settings-btn-primary'}`}
                        onClick={() => handleToggle(plugin)}
                        disabled={installing === plugin.name}
                      >
                        {installing === plugin.name ? '...' : plugin.enabled ? t('common.disable') : t('common.enable')}
                      </button>
                      <button className="settings-btn-sm settings-btn-danger" onClick={() => handleUninstall(plugin)}>{pendingUninstall === plugin.name ? t('settings.plugins.confirmUninstall') : t('common.uninstall')}</button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'marketplace' && (
          <div className="settings-panel-list">
            {marketplaceLoading ? (
              <div className="settings-panel-empty">{t('settings.plugins.loadingMarketplace')}</div>
            ) : marketplacePlugins.length === 0 ? (
              <div className="settings-panel-empty">
                <p>{searchQuery ? t('settings.plugins.noMarketplaceMatch') : t('settings.plugins.noMarketplacePlugins')}</p>
              </div>
            ) : (
              marketplacePlugins.map(plugin => (
                <div key={plugin.name} className={`settings-card${plugin.installed ? ' installed' : ''}`}>
                  <div className="settings-card-row">
                    <div className="settings-card-icon"><span>📦</span></div>
                    <div className="settings-card-info">
                      <div className="settings-card-header">
                        <span className="settings-card-name">{plugin.name}</span>
                        {plugin.installed && <span className="settings-badge installed">{t('settings.plugins.installed')}</span>}
                        {plugin.category && <span className="settings-badge category">{plugin.category}</span>}
                      </div>
                      {plugin.description && <div className="settings-card-desc">{plugin.description}</div>}
                      {plugin.tags && plugin.tags.length > 0 && (
                        <div className="settings-card-tags">
                          {plugin.tags.map(tag => (
                            <span key={tag} className="settings-tag">{tag}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="settings-card-actions">
                      {plugin.installed ? (
                        <button className="settings-btn-sm settings-btn-success" disabled>{t('settings.plugins.installed')}</button>
                      ) : (
                        <button
                          className="settings-btn-sm settings-btn-primary"
                          onClick={() => handleInstallFromMarketplace(plugin)}
                          disabled={installing === plugin.name}
                        >
                          {installing === plugin.name ? t('settings.plugins.installing') : t('common.install')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
