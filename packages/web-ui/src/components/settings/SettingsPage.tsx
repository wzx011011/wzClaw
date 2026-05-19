// ============================================================
// SettingsPage — 设置页面（重构版）
//
// 左侧导航栏 + 右侧面板内容
// 面板: 通用 | 外观 | 模型 | MCP | 插件 | 技能 | Agent | 命令 | 工具 | Hand | 运维
// ============================================================

import { useState } from 'react'
import GeneralPanel from './GeneralPanel'
import AppearancePanel from './AppearancePanel'
import ModelsPanel from './ModelsPanel'
import McpPanel from './McpPanel'
import PluginPanel from './PluginPanel'
import SkillsPanel from './SkillsPanel'
import AgentsPanel from './AgentsPanel'
import CommandsPanel from './CommandsPanel'
import ToolsPanel from './ToolsPanel'
import OperationalPanel from './OperationalPanel'
import HandPanel from './HandPanel'

interface SettingsPageProps {
  /** 关闭设置页面回调 */
  onClose: () => void
  /** 连接状态变化回调（可选，用于通知 App 组件） */
  onConnectionChange?: (connected: boolean) => void
}

type PanelId =
  | 'general' | 'appearance' | 'models' | 'mcp' | 'plugins'
  | 'skills' | 'agents' | 'commands' | 'tools' | 'hands' | 'operational'

interface NavItem { id: PanelId; label: string; icon: string }

const NAV_ITEMS: NavItem[] = [
  { id: 'general', label: '通用', icon: '⚙️' },
  { id: 'appearance', label: '外观', icon: '🎨' },
  { id: 'models', label: '模型', icon: '🤖' },
  { id: 'agents', label: 'Agent', icon: '🧠' },
  { id: 'mcp', label: 'MCP', icon: '🔌' },
  { id: 'plugins', label: '插件', icon: '📦' },
  { id: 'skills', label: '技能', icon: '📚' },
  { id: 'commands', label: '命令', icon: '⌨️' },
  { id: 'tools', label: '工具', icon: '🔧' },
  { id: 'hands', label: 'Hand', icon: '✋' },
  { id: 'operational', label: '运维', icon: '🖥️' },
]

export default function SettingsPage({ onClose }: SettingsPageProps): React.ReactElement {
  const [activePanel, setActivePanel] = useState<PanelId>('general')

  return (
    <div className="settings-page">
      {/* 顶部导航 */}
      <div className="settings-header">
        <button className="settings-back-btn" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>返回</span>
        </button>
        <h2 className="settings-title">设置</h2>
      </div>

      {/* 主体：左侧导航 + 右侧内容 */}
      <div className="settings-layout">
        {/* 左侧导航 */}
        <nav className="settings-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`settings-nav-item${activePanel === item.id ? ' active' : ''}`}
              onClick={() => setActivePanel(item.id)}
            >
              <span className="settings-nav-icon">{item.icon}</span>
              <span className="settings-nav-label">{item.label}</span>
            </button>
          ))}
        </nav>

        {/* 右侧面板 */}
        <div className="settings-body">
          {activePanel === 'general' && <GeneralPanel />}
          {activePanel === 'appearance' && <AppearancePanel />}
          {activePanel === 'models' && <ModelsPanel />}
          {activePanel === 'agents' && <AgentsPanel />}
          {activePanel === 'mcp' && <McpPanel />}
          {activePanel === 'plugins' && <PluginPanel />}
          {activePanel === 'skills' && <SkillsPanel />}
          {activePanel === 'commands' && <CommandsPanel />}
          {activePanel === 'tools' && <ToolsPanel />}
          {activePanel === 'hands' && <HandPanel />}
          {activePanel === 'operational' && <OperationalPanel />}
        </div>
      </div>
    </div>
  )
}


