// ============================================================
// ActivityBar — 左侧活动图标栏
//
// 图标按钮切换侧边栏面板：资源管理器、会话、搜索。
// ============================================================

import React from 'react'
import { useLayoutStore } from '../../stores/layout-store'
import type { SidebarPanel } from '../../stores/layout-store'

/** 活动栏图标配置 */
const ACTIVITIES: Array<{
  id: SidebarPanel
  label: string
  icon: string
}> = [
  { id: 'explorer', label: '资源管理器', icon: '📁' },
  { id: 'sessions', label: '会话', icon: '💬' },
  { id: 'search', label: '搜索', icon: '🔍' },
]

export default function ActivityBar(): React.ReactElement {
  const activePanel = useLayoutStore((s) => s.activeSidebarPanel)
  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible)
  const setActivePanel = useLayoutStore((s) => s.setActiveSidebarPanel)

  return (
    <div style={{
      width: '48px',
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      paddingTop: '8px',
      gap: '4px',
      background: 'var(--bg-primary)',
      borderRight: '1px solid var(--border)',
    }}>
      {ACTIVITIES.map((activity) => {
        const isActive = sidebarVisible && activePanel === activity.id
        return (
          <button
            key={activity.id}
            onClick={() => setActivePanel(activity.id)}
            title={activity.label}
            style={{
              width: '40px',
              height: '40px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: isActive ? 'var(--bg-secondary)' : 'transparent',
              border: 'none',
              borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '18px',
              borderRadius: '0',
            }}
          >
            {activity.icon}
          </button>
        )
      })}
    </div>
  )
}
