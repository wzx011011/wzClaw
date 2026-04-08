import React, { useEffect, useState } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import TitleBar from './TitleBar'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'
import TerminalPanel from './TerminalPanel'
import PreviewPanel from './PreviewPanel'
import MobileConnectModal from './MobileConnectModal'
import ChatPanel from '../chat/ChatPanel'
import CommandPalette from '../CommandPalette'
import TaskPanel from '../chat/TaskPanel'
import ToastContainer from '../chat/ToastContainer'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useChatStore } from '../../stores/chat-store'
import { useCommandStore } from '../../stores/command-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useTerminalStore } from '../../stores/terminal-store'
import { useIndexStore } from '../../stores/index-store'
import { useTaskStore } from '../../stores/task-store'
import { useNotificationStore } from '../../stores/notification-store'

/**
 * IDELayout — Chat-centric layout inspired by Z Code ADE.
 *
 * Layout:
 *   [Left Sidebar (collapsible: Files/Tasks)] | [Chat Panel (center, primary)]
 *   [Terminal Drawer (bottom, toggleable Ctrl+`)]
 *   [StatusBar (fixed bottom)]
 *
 * No code editor panel — chat is the primary interface.
 */
export default function IDELayout(): JSX.Element {
  const openFolder = useWorkspaceStore((s) => s.openFolder)
  const handleWorkspaceFileChange = useWorkspaceStore((s) => s.handleFileChange)
  const initChat = useChatStore((s) => s.init)
  const openPalette = useCommandStore((s) => s.openPalette)
  const registerBuiltInCommands = useCommandStore((s) => s.registerBuiltInCommands)
  const showTerminal = useTerminalStore((s) => s.panelVisible)

  // Sidebar state
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [sidebarTab, setSidebarTab] = useState<'files' | 'tasks'>('files')

  // Right sidebar state
  const [rightSidebarVisible, setRightSidebarVisible] = useState(false)

  // Mobile modal state
  const [mobileModalOpen, setMobileModalOpen] = useState(false)

  // Register global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
      // Ctrl+B — toggle sidebar
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'b') {
        e.preventDefault()
        setSidebarVisible((v) => !v)
      }
      // Ctrl+Shift+B — toggle right sidebar
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'B') {
        e.preventDefault()
        setRightSidebarVisible((v) => !v)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [openFolder, openPalette])

  // Subscribe to file change events from main process
  useEffect(() => {
    const unsubscribe = window.wzxclaw.onFileChanged((payload) => {
      handleWorkspaceFileChange(payload.filePath, payload.changeType)
    })
    return unsubscribe
  }, [handleWorkspaceFileChange])

  // Auto-open right sidebar when browser screenshot arrives
  useEffect(() => {
    const unsubscribe = window.wzxclaw.onBrowserScreenshot(() => {
      setRightSidebarVisible(true)
    })
    return unsubscribe
  }, [])

  // Subscribe to chat stream events
  useEffect(() => {
    const unsubscribe = initChat()
    return unsubscribe
  }, [initChat])

  // Subscribe to index progress events
  useEffect(() => {
    const unsubscribe = useIndexStore.getState().init()
    return unsubscribe
  }, [])

  // Register built-in commands
  useEffect(() => {
    registerBuiltInCommands({
      openFolder: () => useWorkspaceStore.getState().openFolder(),
      clearConversation: () => useChatStore.getState().clearConversation(),
      createSession: () => useChatStore.getState().createSession(),
      saveActiveTab: () => {},
      updateSettings: (req) => useSettingsStore.getState().updateSettings(req),
      openSettingsModal: () => {
        window.dispatchEvent(new CustomEvent('wzxclaw:open-settings'))
      },
      reindex: () => useIndexStore.getState().reindex()
    })
  }, [registerBuiltInCommands])

  return (
    <div className="ide-container">
      <TitleBar
        onToggleTerminal={() => useTerminalStore.getState().togglePanel()}
        onToggleRightSidebar={() => setRightSidebarVisible((v) => !v)}
        rightSidebarVisible={rightSidebarVisible}
        onConnectPhone={() => {
          setMobileModalOpen(true)
        }}
        onOpenBrowser={() => {
          setRightSidebarVisible(true)
        }}
      />
      <div className="ide-main">
        <div className="ide-content">
          <Allotment>
            {/* Left Sidebar — collapsible files/tasks panel */}
            {sidebarVisible && (
              <Allotment.Pane preferredSize={240} minSize={180} maxSize={400}>
                <div className="sidebar-container">
                  {/* Sidebar tab switcher */}
                  <div className="sidebar-tabs">
                    <button
                      className={`sidebar-tab${sidebarTab === 'files' ? ' active' : ''}`}
                      onClick={() => setSidebarTab('files')}
                    >
                      Files
                    </button>
                    <button
                      className={`sidebar-tab${sidebarTab === 'tasks' ? ' active' : ''}`}
                      onClick={() => setSidebarTab('tasks')}
                    >
                      Tasks
                    </button>
                  </div>
                  {/* Sidebar content */}
                  <div className="sidebar-body">
                    {sidebarTab === 'files' ? (
                      <Sidebar />
                    ) : (
                      <TaskPanel onClose={() => setSidebarTab('files')} />
                    )}
                  </div>
                </div>
              </Allotment.Pane>
            )}

            {/* Center — Chat + Terminal (vertical split) */}
            <Allotment.Pane>
              <Allotment vertical defaultSizes={showTerminal ? [70, 30] : [100]}>
                <Allotment.Pane minSize={200}>
                  <ChatPanel />
                </Allotment.Pane>
                {showTerminal && (
                  <Allotment.Pane minSize={100} preferredSize={200}>
                    <TerminalPanel />
                  </Allotment.Pane>
                )}
              </Allotment>
            </Allotment.Pane>

            {/* Right Sidebar — Preview panel */}
            {rightSidebarVisible && (
              <Allotment.Pane preferredSize={360} minSize={240} maxSize={600}>
                <PreviewPanel />
              </Allotment.Pane>
            )}
          </Allotment>
        </div>
      </div>
      <StatusBar />
      <CommandPalette />
      <ToastContainer />
      {mobileModalOpen && (
        <MobileConnectModal onClose={() => setMobileModalOpen(false)} />
      )}
    </div>
  )
}
