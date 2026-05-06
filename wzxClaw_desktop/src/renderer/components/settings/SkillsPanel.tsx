import { useState, useEffect, useCallback } from 'react'
import { useT } from '../../i18n/useT'

// ============================================================
// SkillsPanel — List all loaded skills
// ============================================================

interface SkillDisplay {
  name: string
  description: string
  source: string
  argumentHint?: string
}

export default function SkillsPanel(): JSX.Element {
  const t = useT()
  const [skills, setSkills] = useState<SkillDisplay[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const loadSkills = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.wzxclaw.listSkills?.() ?? []
      setSkills(list.map(s => ({
        name: s.name,
        description: s.description ?? '',
        source: s.source,
        argumentHint: s.argumentHint,
      })))
    } catch (err) {
      console.error('[SkillsPanel] Failed to load skills:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadSkills() }, [loadSkills])

  const filtered = search
    ? skills.filter(s =>
        s.name.toLowerCase().includes(search.toLowerCase()) ||
        s.description.toLowerCase().includes(search.toLowerCase())
      )
    : skills

  const sourceGroups = new Map<string, SkillDisplay[]>()
  for (const s of filtered) {
    const group = sourceGroups.get(s.source) ?? []
    group.push(s)
    sourceGroups.set(s.source, group)
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel-header">
        <h2 className="settings-panel-title">{t('settings.skills.title')}</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="settings-panel-subtitle">{t('settings.skills.subtitle', { count: skills.length })}</span>
          <button className="settings-btn-secondary" onClick={async () => { await window.wzxclaw.reloadSkills?.(); loadSkills() }}>
            {t('common.refresh')}
          </button>
        </div>
      </div>

      <div className="settings-panel-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="settings-panel-search-input"
          placeholder={t('settings.skills.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="settings-panel-body">
        {loading ? (
          <div className="settings-panel-empty">{t('settings.skills.loading')}</div>
        ) : filtered.length === 0 ? (
          <div className="settings-panel-empty">
            <p>{search ? t('settings.skills.noMatch') : t('settings.skills.empty')}</p>
            <p className="settings-panel-hint" dangerouslySetInnerHTML={{ __html: t('settings.skills.hint') }} />
          </div>
        ) : (
          Array.from(sourceGroups.entries()).map(([source, group]) => (
            <div key={source} className="settings-section">
              <div className="settings-section-title">{source} ({group.length})</div>
              {group.map(skill => (
                <div key={skill.name} className="settings-card flat">
                  <div className="settings-card-row">
                    <div className="settings-card-icon"><span>⚡</span></div>
                    <div className="settings-card-info">
                      <div className="settings-card-header">
                        <span className="settings-card-name">/{skill.name}</span>
                        {skill.argumentHint && <span className="settings-card-version">{skill.argumentHint}</span>}
                      </div>
                      <div className="settings-card-desc">{skill.description}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
