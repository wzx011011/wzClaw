import { useState, useEffect, useCallback, useRef } from 'react'
import { useT } from '../../i18n/useT'
import type { PluginInfo } from '../../../shared/types-plugin'
import type { MarketplacePluginDisplay } from '../../../shared/types-plugin'

interface PluginManagerProps {
  isOpen: boolean
  onClose: () => void
}

type TabId = 'discover' | 'installed' | 'marketplace'

// ============================================================
// PluginManager — 3-tab plugin management UI
// Tabs: 发现 (Discover) | 已安装 (Installed) | 市场 (Marketplace)
// ============================================================

export default function PluginManager({ isOpen, onClose }: PluginManagerProps): JSX.Element | null {
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
  const [configParseError, setConfigParseError] = useState<string | null>(null)
  const [pendingUninstall, setPendingUninstall] = useState<string | null>(null)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  // 清理所有定时器
  useEffect(() => {
    return () => timersRef.current.forEach(id => clearTimeout(id))
  }, [])

  const scheduleActionStatusClear = (ms: number) => {
    const id = setTimeout(() => setActionStatus(null), ms)
    timersRef.current.push(id)
  }

  const loadPlugins = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.wzxclaw.listPlugins()
      setPlugins(list)
    } catch (err) {
      console.error('[PluginManager] Failed to load plugins:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMarketplace = useCallback(async () => {
    setMarketplaceLoading(true)
    try {
      const results = await window.wzxclaw.searchPluginMarketplace({})
      setMarketplacePlugins(results)
    } catch (err) {
      console.error('[PluginManager] Failed to load marketplace:', err)
    } finally {
      setMarketplaceLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen) {
      loadPlugins()
      setActionStatus(null)
      setShowInstall(false)
      setConfigPlugin(null)
      setSearchQuery('')
      if (activeTab === 'marketplace') loadMarketplace()
    }
  }, [isOpen, loadPlugins, activeTab, loadMarketplace])

  useEffect(() => {
    if (isOpen && activeTab === 'marketplace') {
      loadMarketplace()
    }
  }, [activeTab, isOpen, loadMarketplace])

  const handleToggle = async (plugin: PluginInfo): Promise<void> => {
    const fn = plugin.enabled ? window.wzxclaw.disablePlugin : window.wzxclaw.enablePlugin
    setInstalling(plugin.name)
    try {
      const result = await fn({ name: plugin.name })
      setActionStatus(result.message)
      if (result.success) await loadPlugins()
    } finally {
      setInstalling(null)
      scheduleActionStatusClear(3000)
    }
  }

  const handleUninstall = async (plugin: PluginInfo): Promise<void> => {
    // 内联确认：首次点击显示确认，再次点击执行卸载
    if (pendingUninstall !== plugin.name) {
      setPendingUninstall(plugin.name)
      scheduleActionStatusClear(5000) // 5 秒后自动取消确认状态
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
      scheduleActionStatusClear(3000)
    }
  }

  const handleReload = async (): Promise<void> => {
    setLoading(true)
    await window.wzxclaw.reloadPlugins()
    await loadPlugins()
    setActionStatus(t('settings.plugins.reloaded'))
    scheduleActionStatusClear(3000)
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
      scheduleActionStatusClear(5000)
    }
  }

  const handleInstallFromMarketplace = async (plugin: MarketplacePluginDisplay): Promise<void> => {
    setInstalling(plugin.name)
    try {
      const result = await window.wzxclaw.installPluginFromSource({ source: plugin.installSource })
      setActionStatus(result.message)
      if (result.success) {
        await Promise.allSettled([loadPlugins(), loadMarketplace()])
      }
    } catch (err) {
      setActionStatus(t('settings.plugins.installFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setInstalling(null)
      scheduleActionStatusClear(5000)
    }
  }

  const handleOpenConfig = async (pluginName: string): Promise<void> => {
    try {
      const values = await window.wzxclaw.getPluginUserConfig({ pluginName })
      setConfigText(JSON.stringify(values, null, 2))
      setConfigParseError(null)
      setConfigPlugin(pluginName)
    } catch (err) {
      console.error('[PluginManager] Failed to load config:', err)
    }
  }

  const handleSaveConfig = async (): Promise<void> => {
    if (!configPlugin) return
    if (configParseError) {
      setActionStatus(t('settings.plugins.cannotSave', { error: configParseError }))
      scheduleActionStatusClear(3000)
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
      setActionStatus(t('settings.plugins.invalidJson'))
    }
    setTimeout(() => setActionStatus(null), 3000)
  }

  // Get component tags for a plugin
  const getPluginTags = (plugin: PluginInfo): string[] => {
    const tags: string[] = []
    if (plugin.agentCount > 0) tags.push('Agent')
    if (plugin.commandCount > 0) tags.push('Command')
    if (plugin.skillCount > 0) tags.push('Skill')
    if (plugin.hasMcpServers) tags.push('MCP')
    if (plugin.hasHooks) tags.push('Hooks')
    return tags
  }

  // Filter plugins by search query
  const filteredPlugins = searchQuery
    ? plugins.filter(p =>
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (p.description?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
      )
    : plugins

  // Merge installed + marketplace for discover tab
  const installedNames = new Set(plugins.map(p => p.name))
  const marketplaceNotInstalled = marketplacePlugins.filter(p => !installedNames.has(p.name))
  const discoverPlugins = [...filteredPlugins, ...marketplaceNotInstalled]

  if (!isOpen) return null

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal plugin-manager" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="settings-header">
          <h2>{t('settings.plugins.title')}</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="settings-btn-secondary"
              onClick={() => setShowInstall(!showInstall)}
            >
              {t('settings.plugins.installFromUrl')}
            </button>
            <button className="settings-btn-secondary" onClick={handleReload} disabled={loading}>
              {loading ? t('common.loading') : t('common.refresh')}
            </button>
            <button className="settings-close-btn" onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Status bar */}
        {actionStatus && (
          <div className="plugin-status-bar">{actionStatus}</div>
        )}

        {/* Install from URL bar */}
        {showInstall && (
          <div className="plugin-install-bar">
            <input
              type="text"
              className="plugin-install-input"
              placeholder="GitHub repo (user/repo), Git URL, or archive URL"
              value={installUrl}
              onChange={(e) => setInstallUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleInstallFromUrl() }}
              disabled={installing === '__url__'}
            />
            <button
              className="btn-sm btn-primary"
              onClick={handleInstallFromUrl}
              disabled={installing === '__url__' || !installUrl.trim()}
            >
              {installing === '__url__' ? t('settings.plugins.installing') : t('common.install')}
            </button>
          </div>
        )}

        {/* Config editor overlay */}
        {configPlugin && (
          <div className="plugin-config-overlay">
            <div className="plugin-config-panel">
              <div className="settings-header">
                <h3>{t('settings.plugins.configLabel', { name: configPlugin })}</h3>
                <button className="settings-close-btn" onClick={() => setConfigPlugin(null)}>✕</button>
              </div>
              <textarea
                className="plugin-config-editor"
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
              {configParseError && <div className="config-error">{configParseError}</div>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 8 }}>
                <button className="settings-btn-secondary" onClick={() => setConfigPlugin(null)}>
                  {t('common.cancel')}
                </button>
                <button className="btn-sm btn-primary" onClick={handleSaveConfig}>
                  {t('common.save')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tab bar */}
        <div className="plugin-tab-bar">
          {(['discover', 'installed', 'marketplace'] as TabId[]).map(tab => (
            <button
              key={tab}
              className={`plugin-tab${activeTab === tab ? ' active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'discover' ? t('settings.plugins.discover') : tab === 'installed' ? t('settings.plugins.installed') : t('settings.plugins.marketplace')}
              {tab === 'installed' && plugins.length > 0 && (
                <span className="plugin-tab-count">{plugins.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* Search bar */}
        <div className="plugin-search-bar">
          <svg className="plugin-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            className="plugin-search-input"
            placeholder={t('settings.plugins.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Tab content */}
        <div className="settings-body">
          {/* Discover tab — all plugins (installed + builtin) */}
          {activeTab === 'discover' && (
            <div className="plugin-list">
              {loading && discoverPlugins.length === 0 ? (
                <div className="plugin-empty">{t('settings.plugins.loadingPlugins')}</div>
              ) : discoverPlugins.length === 0 ? (
                <div className="plugin-empty">
                  <p>{t('settings.plugins.noPluginsFound')}</p>
                  <p className="plugin-hint">{t('settings.plugins.installedHint')}</p>
                </div>
              ) : (
                discoverPlugins.map(plugin => (
                  <div key={plugin.name} className={`plugin-card ${plugin.enabled ? 'enabled' : 'disabled'}`}>
                    <div className="plugin-card-header">
                      <span className="plugin-card-name">{plugin.name}</span>
                      {plugin.isBuiltin && <span className="plugin-badge builtin">{t('settings.plugins.builtin')}</span>}
                      {plugin.version && <span className="plugin-version">v{plugin.version}</span>}
                    </div>
                    {plugin.description && (
                      <div className="plugin-card-desc">{plugin.description}</div>
                    )}
                    <div className="plugin-card-tags">
                      {getPluginTags(plugin).map(tag => (
                        <span key={tag} className={`plugin-tag plugin-tag-${tag.toLowerCase()}`}>{tag}</span>
                      ))}
                    </div>
                    <div className="plugin-card-footer">
                      <span className="plugin-card-source">{t('settings.plugins.source', { source: plugin.source })}</span>
                      <div className="plugin-card-actions">
                        {plugin.hasUserConfig && (
                          <button className="btn-sm settings-btn-secondary" onClick={() => handleOpenConfig(plugin.name)}>{t('common.config')}</button>
                        )}
                        <button
                          className={`btn-sm ${plugin.enabled ? 'btn-warning' : 'btn-primary'}`}
                          onClick={() => handleToggle(plugin)}
                          disabled={installing === plugin.name}
                        >
                          {installing === plugin.name ? '...' : plugin.enabled ? t('common.disable') : t('common.enable')}
                        </button>
                        {!plugin.isBuiltin && (
                          <button className="btn-sm btn-danger" onClick={() => handleUninstall(plugin)}>{pendingUninstall === plugin.name ? t('settings.plugins.confirmUninstall') : t('common.uninstall')}</button>
                        )}
                      </div>
                    </div>
                    {plugin.errors && plugin.errors.length > 0 && (
                      <div className="plugin-card-errors">
                        {plugin.errors.map((e, i) => (
                          <div key={i} className="plugin-error">{e.message}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* Installed tab — only user-installed plugins with management actions */}
          {activeTab === 'installed' && (
            <div className="plugin-list">
              {plugins.filter(p => !p.isBuiltin).length === 0 ? (
                <div className="plugin-empty">
                  <p>{t('settings.plugins.noInstalledPlugins')}</p>
                  <p className="plugin-hint">{t('settings.plugins.installedHint')}</p>
                </div>
              ) : (
                plugins.filter(p => !p.isBuiltin).map(plugin => (
                  <div key={plugin.name} className={`plugin-card ${plugin.enabled ? 'enabled' : 'disabled'}`}>
                    <div className="plugin-card-header">
                      <span className="plugin-card-name">{plugin.name}</span>
                      {plugin.version && <span className="plugin-version">v{plugin.version}</span>}
                    </div>
                    {plugin.description && (
                      <div className="plugin-card-desc">{plugin.description}</div>
                    )}
                    <div className="plugin-card-tags">
                      {getPluginTags(plugin).map(tag => (
                        <span key={tag} className={`plugin-tag plugin-tag-${tag.toLowerCase()}`}>{tag}</span>
                      ))}
                    </div>
                    <div className="plugin-card-footer">
                      <span className="plugin-card-source">{t('settings.plugins.source', { source: plugin.source })}</span>
                      <div className="plugin-card-actions">
                        {plugin.hasUserConfig && (
                          <button className="btn-sm settings-btn-secondary" onClick={() => handleOpenConfig(plugin.name)}>{t('common.config')}</button>
                        )}
                        <button
                          className={`btn-sm ${plugin.enabled ? 'btn-warning' : 'btn-primary'}`}
                          onClick={() => handleToggle(plugin)}
                          disabled={installing === plugin.name}
                        >
                          {installing === plugin.name ? '...' : plugin.enabled ? t('common.disable') : t('common.enable')}
                        </button>
                        <button className="btn-sm btn-danger" onClick={() => handleUninstall(plugin)}>{pendingUninstall === plugin.name ? t('settings.plugins.confirmUninstall') : t('common.uninstall')}</button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Marketplace tab — discover and install new plugins */}
          {activeTab === 'marketplace' && (
            <div className="plugin-list">
              {marketplaceLoading ? (
                <div className="plugin-empty">{t('settings.plugins.loadingMarketplace')}</div>
              ) : marketplacePlugins.length === 0 ? (
                <div className="plugin-empty">
                  <p>{searchQuery ? t('settings.plugins.noMarketplaceMatch') : t('settings.plugins.noMarketplacePlugins')}</p>
                </div>
              ) : (
                marketplacePlugins.map(plugin => (
                  <div key={plugin.name} className={`plugin-card${plugin.installed ? ' installed' : ''}`}>
                    <div className="plugin-card-header">
                      <span className="plugin-card-name">{plugin.name}</span>
                      {plugin.installed && <span className="plugin-badge installed">{t('settings.plugins.installed')}</span>}
                      {plugin.category && <span className="plugin-badge category">{plugin.category}</span>}
                    </div>
                    {plugin.description && (
                      <div className="plugin-card-desc">{plugin.description}</div>
                    )}
                    {plugin.tags && plugin.tags.length > 0 && (
                      <div className="plugin-card-tags">
                        {plugin.tags.map(tag => (
                          <span key={tag} className="plugin-tag">{tag}</span>
                        ))}
                      </div>
                    )}
                    <div className="plugin-card-footer">
                      {plugin.author && (
                        <span className="plugin-card-source">{t('settings.plugins.from', { source: plugin.author })}</span>
                      )}
                      <div className="plugin-card-actions">
                        {plugin.installed ? (
                          <button className="btn-sm btn-success" disabled>{t('settings.plugins.installed')}</button>
                        ) : plugin.isPlaceholder ? (
                          <button className="btn-sm settings-btn-secondary" disabled>{t('settings.plugins.comingSoon')}</button>
                        ) : (
                          <button
                            className="btn-sm btn-primary"
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
    </div>
  )
}
