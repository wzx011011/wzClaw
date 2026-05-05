import { useState, useEffect, useCallback } from 'react'
import type { PluginInfo } from '../../../shared/types-plugin'

interface PluginManagerProps {
  isOpen: boolean
  onClose: () => void
}

/**
 * PluginManager — modal panel for managing installed plugins.
 * Lists all plugins with enable/disable toggles, uninstall buttons,
 * marketplace install, and user-config editing.
 */
export default function PluginManager({ isOpen, onClose }: PluginManagerProps): JSX.Element | null {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [actionStatus, setActionStatus] = useState<string | null>(null)
  const [installUrl, setInstallUrl] = useState('')
  const [installing, setInstalling] = useState(false)
  const [showInstall, setShowInstall] = useState(false)
  const [configPlugin, setConfigPlugin] = useState<string | null>(null)
  const [configValues, setConfigValues] = useState<Record<string, unknown>>({})
  const [configText, setConfigText] = useState('')
  const [configParseError, setConfigParseError] = useState<string | null>(null)

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

  useEffect(() => {
    if (isOpen) {
      loadPlugins()
      setActionStatus(null)
      setShowInstall(false)
      setConfigPlugin(null)
    }
  }, [isOpen, loadPlugins])

  const handleToggle = async (plugin: PluginInfo): Promise<void> => {
    const fn = plugin.enabled ? window.wzxclaw.disablePlugin : window.wzxclaw.enablePlugin
    const result = await fn({ name: plugin.name })
    setActionStatus(result.message)
    if (result.success) {
      await loadPlugins()
    }
    setTimeout(() => setActionStatus(null), 3000)
  }

  const handleUninstall = async (plugin: PluginInfo): Promise<void> => {
    if (!confirm(`Are you sure you want to uninstall plugin "${plugin.name}"?`)) return
    const result = await window.wzxclaw.uninstallPlugin({ name: plugin.name })
    setActionStatus(result.message)
    if (result.success) {
      await loadPlugins()
    }
    setTimeout(() => setActionStatus(null), 3000)
  }

  const handleReload = async (): Promise<void> => {
    setLoading(true)
    await window.wzxclaw.reloadPlugins()
    await loadPlugins()
    setActionStatus('Plugins reloaded')
    setTimeout(() => setActionStatus(null), 3000)
  }

  const handleInstallFromUrl = async (): Promise<void> => {
    const url = installUrl.trim()
    if (!url) return
    setInstalling(true)
    try {
      // Detect source type from URL
      let source: { source: 'github' | 'git' | 'url'; repo?: string; url?: string; ref?: string }
      const githubMatch = url.match(/^([\w-]+\/[\w.-]+)(?:#(.+))?$/)
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
      setActionStatus(`Install failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setInstalling(false)
      setTimeout(() => setActionStatus(null), 5000)
    }
  }

  const handleOpenConfig = async (pluginName: string): Promise<void> => {
    try {
      const values = await window.wzxclaw.getPluginUserConfig({ pluginName })
      setConfigValues(values)
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
      setActionStatus('Cannot save: ' + configParseError)
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
      if (result.success) {
        setConfigValues(parsed)
        setConfigPlugin(null)
      }
    } catch {
      setActionStatus('Cannot save: invalid JSON')
    }
    setActionStatus(result.message)
    if (result.success) {
      setConfigPlugin(null)
    }
    setTimeout(() => setActionStatus(null), 3000)
  }

  if (!isOpen) return null

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal plugin-manager" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Plugins</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="settings-btn-secondary"
              onClick={() => setShowInstall(!showInstall)}
            >
              Install
            </button>
            <button className="settings-btn-secondary" onClick={handleReload} disabled={loading}>
              Reload
            </button>
            <button className="settings-close-btn" onClick={onClose}>✕</button>
          </div>
        </div>

        {actionStatus && (
          <div className="plugin-status-bar">{actionStatus}</div>
        )}

        {/* Install from URL / GitHub */}
        {showInstall && (
          <div className="plugin-install-bar">
            <input
              type="text"
              className="plugin-install-input"
              placeholder="GitHub repo (user/repo), git URL, or archive URL"
              value={installUrl}
              onChange={(e) => setInstallUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleInstallFromUrl() }}
              disabled={installing}
            />
            <button
              className="btn-sm btn-primary"
              onClick={handleInstallFromUrl}
              disabled={installing || !installUrl.trim()}
            >
              {installing ? 'Installing...' : 'Install'}
            </button>
          </div>
        )}

        {/* User config editor */}
        {configPlugin && (
          <div className="plugin-config-overlay">
            <div className="plugin-config-panel">
              <div className="settings-header">
                <h3>Config: {configPlugin}</h3>
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
                    setConfigParseError('Invalid JSON')
                  }
                }}
              />
              {configParseError && <div className="config-error">{configParseError}</div>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 8 }}>
                <button className="settings-btn-secondary" onClick={() => setConfigPlugin(null)}>
                  Cancel
                </button>
                <button className="btn-sm btn-primary" onClick={handleSaveConfig}>
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="settings-body">
          {loading && plugins.length === 0 ? (
            <div className="plugin-empty">Loading plugins...</div>
          ) : plugins.length === 0 ? (
            <div className="plugin-empty">
              <p>No plugins installed.</p>
              <p className="plugin-hint">
                Place plugins in <code>~/.wzxclaw/plugins/</code> or{' '}
                <code>.wzxclaw/plugins/</code> in your project.
              </p>
              <p className="plugin-hint">
                Or click <strong>Install</strong> to install from GitHub, git, or URL.
              </p>
            </div>
          ) : (
            <div className="plugin-list">
              {plugins.map((plugin) => (
                <div key={plugin.name} className={`plugin-item ${plugin.enabled ? 'enabled' : 'disabled'}`}>
                  <div className="plugin-item-info">
                    <div className="plugin-item-name">
                      {plugin.name}
                      {plugin.isBuiltin && <span className="plugin-badge">builtin</span>}
                      {plugin.version && <span className="plugin-version">v{plugin.version}</span>}
                    </div>
                    {plugin.description && (
                      <div className="plugin-item-desc">{plugin.description}</div>
                    )}
                    <div className="plugin-item-meta">
                      <span>Source: {plugin.source}</span>
                      <span>Commands: {plugin.commandCount}</span>
                      <span>Skills: {plugin.skillCount}</span>
                      <span>Agents: {plugin.agentCount}</span>
                      {plugin.hasMcpServers && <span className="plugin-tag-mcp">MCP</span>}
                      {plugin.hasHooks && <span className="plugin-tag-hooks">Hooks</span>}
                      {plugin.hasUserConfig && <span className="plugin-tag-config">Config</span>}
                    </div>
                    {plugin.errors && plugin.errors.length > 0 && (
                      <div className="plugin-item-errors">
                        {plugin.errors.map((e, i) => (
                          <div key={i} className="plugin-error">{e.message}</div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="plugin-item-actions">
                    <button
                      className={`btn-sm ${plugin.enabled ? 'btn-warning' : 'btn-primary'}`}
                      onClick={() => handleToggle(plugin)}
                    >
                      {plugin.enabled ? 'Disable' : 'Enable'}
                    </button>
                    {plugin.hasUserConfig && (
                      <button
                        className="btn-sm settings-btn-secondary"
                        onClick={() => handleOpenConfig(plugin.name)}
                      >
                        Config
                      </button>
                    )}
                    {!plugin.isBuiltin && (
                      <button
                        className="btn-sm btn-danger"
                        onClick={() => handleUninstall(plugin)}
                      >
                        Uninstall
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
