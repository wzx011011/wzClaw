import { useState, useEffect, useCallback } from 'react'
import { useT } from '../../i18n/useT'

// ============================================================
// CommandsPanel — List all slash commands
// ============================================================

interface CommandDisplay {
  name: string
  description: string
  source: string
}

export default function CommandsPanel(): JSX.Element {
  const t = useT()
  const [commands, setCommands] = useState<CommandDisplay[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const loadCommands = useCallback(async () => {
    setLoading(true)
    try {
      // Load skills (which include commands from plugins)
      const skills = await window.wzxclaw.listSkills?.() ?? []
      const cmds = skills
        .filter(s => s.source === 'plugin-command' || s.source === 'bundled' || s.source === 'user' || s.source === 'project')
        .map(s => ({
          name: s.name,
          description: s.description ?? '',
          source: s.source,
        }))
      setCommands(cmds)
    } catch (err) {
      console.error('[CommandsPanel] Failed to load commands:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadCommands() }, [loadCommands])

  const filtered = search
    ? commands.filter(c =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.description.toLowerCase().includes(search.toLowerCase())
      )
    : commands

  return (
    <div className="settings-panel">
      <div className="settings-panel-header">
        <h2 className="settings-panel-title">{t('settings.commands.title')}</h2>
        <span className="settings-panel-subtitle">{t('settings.commands.subtitle', { count: commands.length })}</span>
      </div>

      <div className="settings-panel-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="settings-panel-search-input"
          placeholder={t('settings.commands.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="settings-panel-body">
        {loading ? (
          <div className="settings-panel-empty">{t('settings.commands.loading')}</div>
        ) : filtered.length === 0 ? (
          <div className="settings-panel-empty">
            <p>{search ? t('settings.commands.noMatch') : t('settings.commands.empty')}</p>
            <p className="settings-panel-hint" dangerouslySetInnerHTML={{ __html: t('settings.commands.hint') }} />
          </div>
        ) : (
          filtered.map(cmd => (
            <div key={cmd.name} className="settings-card flat">
              <div className="settings-card-row">
                <div className="settings-card-icon"><span>💻</span></div>
                <div className="settings-card-info">
                  <div className="settings-card-header">
                    <span className="settings-card-name">/{cmd.name}</span>
                    <span className="settings-badge muted">{cmd.source}</span>
                  </div>
                  <div className="settings-card-desc">{cmd.description}</div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
