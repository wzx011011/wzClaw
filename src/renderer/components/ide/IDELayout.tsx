import React, { useEffect } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'
import TabBar from './TabBar'
import EditorPanel from './EditorPanel'
import WelcomeScreen from './WelcomeScreen'
import ChatPanel from '../chat/ChatPanel'
import { useTabStore } from '../../stores/tab-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useChatStore } from '../../stores/chat-store'

/**
 * IDELayout — root layout component for the IDE (per D-41, D-44, D-51, D-52, D-57).
 * Uses allotment for resizable split between sidebar, editor area, and chat panel.
 *
 * Wires:
 * - Global Ctrl+S save (per D-51)
 * - File change events from chokidar/agent (per D-52)
 * - Ctrl+Shift+O open folder
 * - Chat store stream event subscriptions (per D-54)
 *
 * Layout:
 *   [Sidebar (resizable)] | [TabBar + EditorPanel/WelcomeScreen] | [ChatPanel (resizable)]
 *   [StatusBar (fixed bottom)]
 */
export default function IDELayout(): JSX.Element {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const hasTabs = useTabStore((s) => s.tabs.length > 0)
  const saveTab = useTabStore((s) => s.saveTab)
  const openFolder = useWorkspaceStore((s) => s.openFolder)
  const handleWorkspaceFileChange = useWorkspaceStore((s) => s.handleFileChange)
  const handleTabFileChange = useTabStore((s) => s.handleExternalFileChange)
  const initChat = useChatStore((s) => s.init)

  // Register global keyboard shortcuts (per D-51)
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

  // Subscribe to file change events from main process (per D-52).
  // Updates both workspace tree and open editor tabs.
  useEffect(() => {
    const unsubscribe = window.wzxclaw.onFileChanged((payload) => {
      handleWorkspaceFileChange(payload.filePath, payload.changeType)
      handleTabFileChange(payload.filePath, payload.changeType)
    })
    return unsubscribe
  }, [handleWorkspaceFileChange, handleTabFileChange])

  // Subscribe to chat stream events (per D-54).
  useEffect(() => {
    const unsubscribe = initChat()
    return unsubscribe
  }, [initChat])

  return (
    <div className="ide-container">
      <div className="ide-main">
        <Allotment defaultSizes={[200, 500, 350]} minSizes={[150, 300, 250]}>
          <Allotment.Pane preferredSize={200} minSize={150} maxSize={500}>
            <Sidebar />
          </Allotment.Pane>
          <Allotment.Pane>
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              {hasTabs && <TabBar />}
              {hasTabs ? <EditorPanel /> : <WelcomeScreen />}
            </div>
          </Allotment.Pane>
          <Allotment.Pane preferredSize={350} minSize={250} maxSize={600}>
            <ChatPanel />
          </Allotment.Pane>
        </Allotment>
      </div>
      <StatusBar />
    </div>
  )
}
