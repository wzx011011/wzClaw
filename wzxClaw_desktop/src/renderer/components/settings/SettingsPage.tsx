import { useState, useEffect } from 'react'
import { useT } from '../../i18n/useT'
import PluginPanel from './PluginPanel'
import ToolsPanel from './ToolsPanel'
import ModelsPanel from './ModelsPanel'
import McpPanel from './McpPanel'
import SkillsPanel from './SkillsPanel'
import AgentsPanel from './AgentsPanel'
import CommandsPanel from './CommandsPanel'
import GeneralPanel from './GeneralPanel'
import AppearancePanel from './AppearancePanel'

// ============================================================
// SettingsPage — Full-screen settings UI with sidebar navigation
// Modeled after Claude Desktop's settings layout
// ============================================================

export type SettingsTab = 'plugins' | 'tools' | 'models' | 'mcp' | 'general' | 'appearance' | 'skills' | 'agents' | 'commands'

interface SettingsPageProps {
  isOpen: boolean
  onClose: () => void
  initialTab?: SettingsTab
}

interface NavItem {
  id: SettingsTab
  labelKey: string
  icon: string
}

const NAV_ITEMS: NavItem[] = [
  { id: 'tools', labelKey: 'settings.nav.tools', icon: '🔧' },
  { id: 'models', labelKey: 'settings.nav.models', icon: '🤖' },
  { id: 'mcp', labelKey: 'settings.nav.mcp', icon: '🔌' },
  { id: 'general', labelKey: 'settings.nav.general', icon: '⚙️' },
  { id: 'appearance', labelKey: 'settings.nav.appearance', icon: '🎨' },
  { id: 'skills', labelKey: 'settings.nav.skills', icon: '⚡' },
  { id: 'agents', labelKey: 'settings.nav.agents', icon: '🧠' },
  { id: 'commands', labelKey: 'settings.nav.commands', icon: '💻' },
  { id: 'plugins', labelKey: 'settings.nav.plugins', icon: '🧩' },
]

export default function SettingsPage({ isOpen, onClose, initialTab }: SettingsPageProps): JSX.Element | null {
  const t = useT()
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'plugins')

  useEffect(() => {
    if (isOpen && initialTab) {
      setActiveTab(initialTab)
    }
  }, [isOpen, initialTab])

  const renderPanel = (): JSX.Element => {
    switch (activeTab) {
      case 'plugins': return <PluginPanel />
      case 'tools': return <ToolsPanel />
      case 'models': return <ModelsPanel />
      case 'mcp': return <McpPanel />
      case 'general': return <GeneralPanel />
      case 'appearance': return <AppearancePanel />
      case 'skills': return <SkillsPanel />
      case 'agents': return <AgentsPanel />
      case 'commands': return <CommandsPanel />
      default: return <PluginPanel />
    }
  }

  if (!isOpen) return null

  return (
    <div className="settings-page-overlay" onClick={onClose}>
      <div className="settings-page" onClick={(e) => e.stopPropagation()}>
        {/* Sidebar */}
        <nav className="settings-sidebar">
          <div className="settings-sidebar-header">
            <button className="settings-back-btn" onClick={onClose} title={t('settings.backToWorkspace')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              <span>{t('settings.backToWorkspace')}</span>
            </button>
          </div>
          <div className="settings-sidebar-nav">
            {NAV_ITEMS.map(item => (
              <button
                key={item.id}
                className={`settings-nav-item${activeTab === item.id ? ' active' : ''}`}
                onClick={() => setActiveTab(item.id)}
              >
                <span className="settings-nav-icon">{item.icon}</span>
                <span className="settings-nav-label">{t(item.labelKey)}</span>
              </button>
            ))}
          </div>
        </nav>

        {/* Main content */}
        <main className="settings-content">
          {renderPanel()}
        </main>
      </div>
    </div>
  )
}
