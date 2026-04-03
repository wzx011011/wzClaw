import React, { useCallback } from 'react'
import { useTabStore } from '../../stores/tab-store'

/**
 * TabBar — horizontal row of editor tabs (per EDIT-02, D-50).
 * Shows file name, dirty indicator, close button.
 */

export default function TabBar(): JSX.Element {
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const setActiveTab = useTabStore((s) => s.setActiveTab)
  const closeTab = useTabStore((s) => s.closeTab)

  const handleTabClick = useCallback(
    (tabId: string) => {
      setActiveTab(tabId)
    },
    [setActiveTab]
  )

  const handleClose = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation()
      closeTab(tabId)
    },
    [closeTab]
  )

  const handleMiddleClick = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      if (e.button === 1) {
        // Middle click
        e.preventDefault()
        closeTab(tabId)
      }
    },
    [closeTab]
  )

  if (tabs.length === 0) return <div className="tab-bar" />

  return (
    <div className="tab-bar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab-item${tab.id === activeTabId ? ' active' : ''}`}
          onClick={() => handleTabClick(tab.id)}
          onMouseDown={(e) => handleMiddleClick(e, tab.id)}
          title={tab.filePath}
        >
          <span className="tab-name">{tab.fileName}</span>
          {tab.isDirty && <span className="tab-dirty">{'\u2022'}</span>}
          <button
            className="tab-close"
            onClick={(e) => handleClose(e, tab.id)}
            title="Close"
          >
            {'\u00D7'}
          </button>
        </div>
      ))}
    </div>
  )
}
