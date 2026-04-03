import React, { useEffect } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'
import TabBar from './TabBar'
import EditorPanel from './EditorPanel'
import WelcomeScreen from './WelcomeScreen'
import { useTabStore } from '../../stores/tab-store'
import { useWorkspaceStore } from '../../stores/workspace-store'

/**
 * IDELayout — root layout component for the IDE (per D-41, D-44).
 * Uses allotment for resizable split between sidebar and editor area.
 *
 * Layout:
 *   [Sidebar (resizable)] | [TabBar + EditorPanel/WelcomeScreen]
 *   [StatusBar (fixed bottom)]
 */
export default function IDELayout(): JSX.Element {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const hasTabs = useTabStore((s) => s.tabs.length > 0)
  const saveTab = useTabStore((s) => s.saveTab)
  const openFolder = useWorkspaceStore((s) => s.openFolder)
  const handleFileChange = useWorkspaceStore((s) => s.handleFileChange)

  // Register global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+S / Cmd+S — save active tab
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        if (activeTabId) {
          saveTab(activeTabId)
        }
      }
      // Ctrl+Shift+O — open folder
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'O') {
        e.preventDefault()
        openFolder()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTabId, saveTab, openFolder])

  // Subscribe to file change events from main process
  useEffect(() => {
    const unsubscribe = window.wzxclaw.onFileChange((payload) => {
      handleFileChange(payload.filePath, payload.changeType)
    })
    return unsubscribe
  }, [handleFileChange])

  return (
    <div className="ide-container">
      <div className="ide-main">
        <Allotment defaultSizes={[250, 750]} minSizes={[150, 300]}>
          <Allotment.Pane preferredSize={250} minSize={150} maxSize={500}>
            <Sidebar />
          </Allotment.Pane>
          <Allotment.Pane>
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              {hasTabs && <TabBar />}
              {hasTabs ? <EditorPanel /> : <WelcomeScreen />}
            </div>
          </Allotment.Pane>
        </Allotment>
      </div>
      <StatusBar />
    </div>
  )
}
