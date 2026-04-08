import React, { useEffect } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'
import TabBar from './TabBar'
import EditorPanel from './EditorPanel'
import WelcomeScreen from './WelcomeScreen'
import TerminalPanel from './TerminalPanel'
import ChatPanel from '../chat/ChatPanel'
import CommandPalette from '../CommandPalette'
import { useTabStore } from '../../stores/tab-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useChatStore } from '../../stores/chat-store'
import { useCommandStore } from '../../stores/command-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useTerminalStore } from '../../stores/terminal-store'
import { useIndexStore } from '../../stores/index-store'

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
  const openPalette = useCommandStore((s) => s.openPalette)
  const registerBuiltInCommands = useCommandStore((s) => s.registerBuiltInCommands)
  const showTerminal = useTerminalStore((s) => s.panelVisible)

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
      // Ctrl+Shift+P — command palette
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'P') {
        e.preventDefault()
        openPalette()
      }
      // Ctrl+T — new chat session
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 't') {
        e.preventDefault()
        useChatStore.getState().createSession()
      }
      // Ctrl+` — toggle terminal panel
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === '`') {
        e.preventDefault()
        useTerminalStore.getState().togglePanel()
      }
      // Ctrl+Shift+` — new terminal when panel visible
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === '`') {
        e.preventDefault()
        if (useTerminalStore.getState().panelVisible) {
          useTerminalStore.getState().createTerminal()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTabId, saveTab, openFolder, openPalette])

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

  // Subscribe to index progress events (per IDX-06).
  useEffect(() => {
    const unsubscribe = useIndexStore.getState().init()
    return unsubscribe
  }, [])

  // Register built-in commands once on mount (per CMD-01)
  useEffect(() => {
    registerBuiltInCommands({
      openFolder: () => useWorkspaceStore.getState().openFolder(),
      clearConversation: () => useChatStore.getState().clearConversation(),
      createSession: () => useChatStore.getState().createSession(),
      saveActiveTab: () => {
        const activeId = useTabStore.getState().activeTabId
        if (activeId) useTabStore.getState().saveTab(activeId)
      },
      updateSettings: (req) => useSettingsStore.getState().updateSettings(req),
      openSettingsModal: () => {
        window.dispatchEvent(new CustomEvent('wzxclaw:open-settings'))
      },
      reindex: () => useIndexStore.getState().reindex()
    })
  }, [registerBuiltInCommands])

  return (
    <div className="ide-container">
      <div className="ide-main">
        <Allotment defaultSizes={[200, 500, 350]} minSizes={[150, 300, 250]}>
          <Allotment.Pane preferredSize={200} minSize={150} maxSize={500}>
            <Sidebar />
          </Allotment.Pane>
          <Allotment.Pane>
            <Allotment vertical defaultSizes={showTerminal ? [70, 30] : [100]}>
              <Allotment.Pane minSize={200}>
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  {hasTabs && <TabBar />}
                  {hasTabs ? <EditorPanel /> : <WelcomeScreen />}
                </div>
              </Allotment.Pane>
              {showTerminal && (
                <Allotment.Pane minSize={100}>
                  <TerminalPanel />
                </Allotment.Pane>
              )}
            </Allotment>
          </Allotment.Pane>
          <Allotment.Pane preferredSize={350} minSize={250} maxSize={600}>
            <ChatPanel />
          </Allotment.Pane>
        </Allotment>
      </div>
      <StatusBar />
      <CommandPalette />
    </div>
  )
}
