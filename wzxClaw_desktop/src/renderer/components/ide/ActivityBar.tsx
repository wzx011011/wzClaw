import React from 'react'
import { useLayoutStore, type SidebarPanel } from '../../stores/layout-store'
import { useCommandStore } from '../../stores/command-store'

// ============================================================
// ActivityBar — VS Code 风格竖向图标活动栏
// 48px 固定宽度，点击切换侧边栏面板，再次点击同一项关闭
// ============================================================

interface ActivityBarItem {
  id: SidebarPanel | 'search' | 'settings'
  label: string
  icon: React.ReactNode
  action?: () => void // 自定义点击行为（不切换 sidebar panel）
}

const ITEMS: ActivityBarItem[] = [
  {
    id: 'explorer',
    label: '资源管理器',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V9C21 7.89543 20.1046 7 19 7H13L11 5H5C3.89543 5 3 5.89543 3 7Z" />
      </svg>
    ),
  },
  {
    id: 'sessions',
    label: '会话管理',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15C21 15.5304 20.7893 16.0391 20.4142 16.4142C20.0391 16.7893 19.5304 17 19 17H7L3 21V5C3 4.46957 3.21071 3.96086 3.58579 3.58579C3.96086 3.21071 4.46957 3 5 3H19C19.5304 3 20.0391 3.21071 20.4142 3.58579C20.7893 3.96086 21 4.46957 21 5V15Z" />
      </svg>
    ),
  },
  {
    id: 'search',
    label: '搜索',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    ),
    action: () => useCommandStore.getState().openPalette(),
  },
  {
    id: 'settings',
    label: '设置',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
    action: () => window.dispatchEvent(new CustomEvent('wzxclaw:open-settings')),
  },
]

export default function ActivityBar(): JSX.Element {
  const activeSidebarPanel = useLayoutStore((s) => s.activeSidebarPanel)
  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible)
  const setActiveSidebarPanel = useLayoutStore((s) => s.setActiveSidebarPanel)

  const handleClick = (item: ActivityBarItem): void => {
    if (item.action) {
      item.action()
      return
    }
    setActiveSidebarPanel(item.id as SidebarPanel)
  }

  return (
    <div className="activity-bar">
      {ITEMS.map((item) => {
        const isActive = !item.action && item.id === activeSidebarPanel && sidebarVisible
        return (
          <button
            key={item.id}
            className={`activity-bar-item${isActive ? ' active' : ''}`}
            title={item.label}
            onClick={() => handleClick(item)}
          >
            {item.icon}
            {isActive && <span className="activity-bar-indicator" />}
          </button>
        )
      })}
    </div>
  )
}
