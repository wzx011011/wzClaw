import { useState, useEffect, useCallback } from 'react'
import { useT } from '../../i18n/useT'

// ============================================================
// AgentsPanel — List loaded sub-agents
// ============================================================

interface AgentDisplay {
  name: string
  description: string
  pluginName?: string
}

export default function AgentsPanel(): JSX.Element {
  const t = useT()
  const [agents, setAgents] = useState<AgentDisplay[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const loadAgents = useCallback(async () => {
    setLoading(true)
    try {
      // Reuse plugin:get-skills to find agent-type skills
      const skills = await window.wzxclaw.getPluginSkills?.({}) ?? []
      const agentSkills = skills.filter(s => s.source === 'plugin-agent' || s.name.includes('agent'))
      setAgents(agentSkills.map(s => ({
        name: s.name,
        description: s.description ?? '',
        pluginName: s.source,
      })))

      // Also check for Agent tool presence
      const tools = await window.wzxclaw.listTools?.() ?? []
      const agentTool = tools.find(tool => tool.name === 'Agent')
      if (agentTool && agents.length === 0) {
        setAgents([{
          name: t('settings.agents.defaultName'),
          description: t('settings.agents.defaultDesc'),
        }])
      }
    } catch (err) {
      console.error('[AgentsPanel] Failed to load agents:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAgents() }, [loadAgents])

  const filtered = search
    ? agents.filter(a =>
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.description.toLowerCase().includes(search.toLowerCase())
      )
    : agents

  return (
    <div className="settings-panel">
      <div className="settings-panel-header">
        <h2 className="settings-panel-title">{t('settings.agents.title')}</h2>
        <span className="settings-panel-subtitle">{t('settings.agents.subtitle', { count: agents.length })}</span>
      </div>

      <div className="settings-panel-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="settings-panel-search-input"
          placeholder={t('settings.agents.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="settings-panel-body">
        {loading ? (
          <div className="settings-panel-empty">{t('settings.agents.loading')}</div>
        ) : filtered.length === 0 ? (
          <div className="settings-panel-empty">
            <p>{search ? t('settings.agents.noMatch') : t('settings.agents.empty')}</p>
            <p className="settings-panel-hint" dangerouslySetInnerHTML={{ __html: t('settings.agents.hint') }} />
          </div>
        ) : (
          filtered.map(agent => (
            <div key={agent.name} className="settings-card flat">
              <div className="settings-card-row">
                <div className="settings-card-icon"><span>🧠</span></div>
                <div className="settings-card-info">
                  <div className="settings-card-header">
                    <span className="settings-card-name">{agent.name}</span>
                    {agent.pluginName && <span className="settings-badge muted">{agent.pluginName}</span>}
                  </div>
                  <div className="settings-card-desc">{agent.description}</div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
