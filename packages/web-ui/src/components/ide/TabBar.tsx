// ============================================================
// TabBar — 编辑器文件标签栏
//
// 显示打开的文件标签，支持切换、关闭、脏标记指示。
// ============================================================

import React, { useCallback } from 'react'
import { useTabStore } from '../../stores/tab-store'

export default function TabBar(): React.ReactElement {
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const activateTab = useTabStore((s) => s.activateTab)
  const closeTab = useTabStore((s) => s.closeTab)

  const handleMiddleClick = useCallback((e: React.MouseEvent, tabId: string) => {
    if (e.button === 1) { // 中键点击关闭
      e.preventDefault()
      closeTab(tabId)
    }
  }, [closeTab])

  if (tabs.length === 0) return <></>

  return (
    <div style={{
      display: 'flex',
      height: '35px',
      background: 'var(--bg-primary)',
      borderBottom: '1px solid var(--border)',
      overflow: 'hidden',
      flexShrink: 0,
    }}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            onClick={() => activateTab(tab.id)}
            onMouseDown={(e) => handleMiddleClick(e, tab.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '0 12px',
              fontSize: 'var(--font-size-xs)',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              background: isActive ? 'var(--bg-secondary)' : 'transparent',
              borderRight: '1px solid var(--border)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              maxWidth: '180px',
              minWidth: '0',
              position: 'relative',
              userSelect: 'none',
            }}
          >
            {/* 脏标记 */}
            {tab.isDirty && (
              <span style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--accent)',
                flexShrink: 0,
              }} />
            )}
            <span style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {tab.fileName}
            </span>
            {/* 关闭按钮 */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                padding: '0 2px',
                fontSize: '14px',
                lineHeight: 1,
                borderRadius: '2px',
                flexShrink: 0,
                opacity: isActive ? 1 : 0,
              }}
            >
              x
            </button>
          </div>
        )
      })}
    </div>
  )
}
