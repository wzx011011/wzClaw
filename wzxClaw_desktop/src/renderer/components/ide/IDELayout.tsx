import React, { useEffect, lazy, Suspense, useState, useRef } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import TitleBar from './TitleBar'
import ActivityBar from './ActivityBar'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'
import TabBar from './TabBar'
import ChatPanel from '../chat/ChatPanel'
import CommandPalette from '../CommandPalette'
import ToastContainer from '../chat/ToastContainer'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useChatStore } from '../../stores/chat-store'
import { useCommandStore } from '../../stores/command-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useTerminalStore } from '../../stores/terminal-store'
import { useIndexStore } from '../../stores/index-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useLayoutStore } from '../../stores/layout-store'

// 重型组件懒加载 — 拆分 Monaco/xterm bundle，首屏不下载
const TerminalPanel = lazy(() => import('./TerminalPanel'))
const EditorPanel = lazy(() => import('./EditorPanel'))
const PreviewPanel = lazy(() => import('./PreviewPanel'))
const MobileConnectModal = lazy(() => import('./MobileConnectModal'))

const WORKSPACE_RESTORE_DELAY_MS = 60
const INDEX_INIT_DELAY_MS = 220

function scheduleDeferredUiWork(task: () => void, delayMs: number): () => void {
  const timeoutId = window.setTimeout(task, delayMs)
  return () => window.clearTimeout(timeoutId)
}

/**
 * IDELayout — Chat-centric layout with Activity Bar + left sidebar + right sidebar.
 *
 * Layout:
 *   [ActivityBar 48px] | [Left Sidebar] | [Chat Panel (center)] | [Right Sidebar]
 *   [StatusBar (fixed bottom)]
 */
export default function IDELayout(): JSX.Element {
  const openFolder = useWorkspaceStore((s) => s.openFolder)
  const initWorkspace = useWorkspaceStore((s) => s.initWorkspace)
  const setFolder = useWorkspaceStore((s) => s.setFolder)
  const setFolders = useWorkspaceStore((s) => s.setFolders)
  const handleWorkspaceFileChange = useWorkspaceStore((s) => s.handleFileChange)
  const initChat = useChatStore((s) => s.init)
  const openPalette = useCommandStore((s) => s.openPalette)
  const registerBuiltInCommands = useCommandStore((s) => s.registerBuiltInCommands)
  const showTerminal = useTerminalStore((s) => s.panelVisible)
  const closeWorkspace = useWorkspaceStore((s) => s.closeWorkspace)
  const activeWorkspace = useWorkspaceStore((s) => s.getActiveWorkspace)()

  // 布局状态 — 从 layout-store 读取（持久化到 localStorage）
  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible)
  const activeSidebarPanel = useLayoutStore((s) => s.activeSidebarPanel)
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth)
  const rightSidebarVisible = useLayoutStore((s) => s.rightSidebarVisible)
  const rightSidebarTab = useLayoutStore((s) => s.rightSidebarTab)
  const rightSidebarWidth = useLayoutStore((s) => s.rightSidebarWidth)
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar)
  const toggleRightSidebar = useLayoutStore((s) => s.toggleRightSidebar)
  const setRightSidebarVisible = useLayoutStore((s) => s.setRightSidebarVisible)
  const setRightSidebarTab = useLayoutStore((s) => s.setRightSidebarTab)
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth)
  const setRightSidebarWidth = useLayoutStore((s) => s.setRightSidebarWidth)

  // Mobile modal state
  const [mobileModalOpen, setMobileModalOpen] = React.useState(false)

  // 拖拽分割线时启用全屏 overlay，防止 Monaco/xterm 在每个像素变化时触发内部重计算
  const [isDragging, setIsDragging] = useState(false)
  const dragCountRef = useRef(0)
  const handlePaneDragStart = () => {
    dragCountRef.current += 1
    setIsDragging(true)
  }
  const handlePaneDragEnd = (sizes: number[]) => {
    dragCountRef.current = Math.max(0, dragCountRef.current - 1)
    if (dragCountRef.current === 0) setIsDragging(false)
    handleAllotmentChange(sizes)
  }
  const handleVerticalDragStart = () => {
    dragCountRef.current += 1
    setIsDragging(true)
  }
  const handleVerticalDragEnd = () => {
    dragCountRef.current = Math.max(0, dragCountRef.current - 1)
    if (dragCountRef.current === 0) setIsDragging(false)
  }

  // 懒加载 keep-alive 状态 — 首次打开后保持挂载，用 CSS 切换可见性
  const [editorMounted, setEditorMounted] = useState(() => rightSidebarVisible && rightSidebarTab === 'editor')
  const [previewMounted, setPreviewMounted] = useState(() => rightSidebarVisible && rightSidebarTab === 'preview')
  const [terminalMounted, setTerminalMounted] = useState(false)
  const prevTerminalVisible = useRef(false)

  // Auto-open right sidebar with editor when file is opened
  useEffect(() => {
    const handler = () => {
      setEditorMounted(true)
      setRightSidebarVisible(true)
      setRightSidebarTab('editor')
    }
    window.addEventListener('wzxclaw:file-opened', handler)
    return () => window.removeEventListener('wzxclaw:file-opened', handler)
  }, [setRightSidebarVisible, setRightSidebarTab])

  // 当右侧 tab 切换时触发对应组件 mount（之后 CSS keep-alive）
  useEffect(() => {
    if (rightSidebarVisible) {
      if (rightSidebarTab === 'editor') setEditorMounted(true)
      if (rightSidebarTab === 'preview') setPreviewMounted(true)
    }
  }, [rightSidebarTab, rightSidebarVisible])

  // 当终端面板变为可见时触发 mount（之后 xterm keep-alive）
  useEffect(() => {
    if (showTerminal && !prevTerminalVisible.current) {
      setTerminalMounted(true)
    }
    prevTerminalVisible.current = showTerminal
  }, [showTerminal])

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
        toggleSidebar()
      }
      // Ctrl+Shift+B — toggle right sidebar
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'B') {
        e.preventDefault()
        toggleRightSidebar()
      }
      // F2 — rename (dispatched as custom event for sidebar components)
      if (e.key === 'F2' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('wzxclaw:shortcut-rename'))
        }
      }
      // Delete — delete selected item (dispatched as custom event)
      if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('wzxclaw:shortcut-delete'))
        }
      }
      // Ctrl+N — new session (alias for Ctrl+T)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'n') {
        e.preventDefault()
        useChatStore.getState().createSession()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [openFolder, openPalette, toggleSidebar, toggleRightSidebar])

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
  }, [setRightSidebarVisible])

  // Subscribe to chat stream events
  useEffect(() => {
    const unsubscribe = initChat()
    return unsubscribe
  }, [initChat])

  // Restore workspace after the shell paints so ChatPanel can appear first.
  useEffect(() => {
    const cancelDeferredWorkspaceInit = scheduleDeferredUiWork(() => {
      if (activeWorkspace?.projects && activeWorkspace.projects.length > 0) {
        void setFolders(activeWorkspace.projects)
      } else {
        void initWorkspace()
      }
    }, WORKSPACE_RESTORE_DELAY_MS)

    return cancelDeferredWorkspaceInit
  }, [activeWorkspace?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Index status is useful but not a first-paint dependency.
  useEffect(() => {
    let unsubscribeIndex: (() => void) | null = null
    const cancelDeferredIndexInit = scheduleDeferredUiWork(() => {
      unsubscribeIndex = useIndexStore.getState().init()
    }, INDEX_INIT_DELAY_MS)

    return () => {
      cancelDeferredIndexInit()
      unsubscribeIndex?.()
    }
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

  // 持久化 Allotment 拖拽后的面板宽度
  const handleAllotmentChange = (sizes: number[]): void => {
    if (!sidebarVisible || sizes.length < 2) return
    // ActivityBar 占第一个 pane (48px)，sidebar 是第二个
    const newSidebarWidth = Math.round(sizes[1])
    if (newSidebarWidth > 100) {
      setSidebarWidth(newSidebarWidth)
    }
  }

  return (
    <div className="ide-container">
      <TitleBar
        onOpenFolder={() => useWorkspaceStore.getState().openFolder()}
        onToggleTerminal={() => useTerminalStore.getState().togglePanel()}
        onToggleRightSidebar={toggleRightSidebar}
        rightSidebarVisible={rightSidebarVisible}
        onConnectPhone={() => {
          setMobileModalOpen(true)
        }}
        onOpenBrowser={() => {
          setRightSidebarTab('preview')
        }}
        onBackToTasks={closeWorkspace}
        activeWorkspaceTitle={activeWorkspace?.title}
      />
      <div className="ide-main">
        <div className="ide-content">
          <Allotment onDragStart={handlePaneDragStart} onDragEnd={handlePaneDragEnd}>
            {/* Activity Bar — 固定 48px 图标条 */}
            <Allotment.Pane minSize={48} maxSize={48} preferredSize={48}>
              <ActivityBar />
            </Allotment.Pane>

            {/* Left Sidebar — 文件浏览器 / 会话列表 */}
            {sidebarVisible && (
              <Allotment.Pane preferredSize={sidebarWidth} minSize={180} maxSize={400}>
                <Sidebar activePanel={activeSidebarPanel} />
              </Allotment.Pane>
            )}

            {/* Center — Chat + Terminal (vertical split) */}
            <Allotment.Pane>
              <Allotment vertical defaultSizes={showTerminal ? [70, 30] : [100]} onDragStart={handleVerticalDragStart} onDragEnd={handleVerticalDragEnd}>
                <Allotment.Pane minSize={200}>
                  <ChatPanel />
                </Allotment.Pane>
                {/* Terminal — 首次打开后 keep-alive；隐藏时用 Allotment maxSize=0 折叠 */}
                {terminalMounted && (
                  <Allotment.Pane minSize={showTerminal ? 100 : 0} maxSize={showTerminal ? undefined : 0} preferredSize={200} snap>
                    <Suspense fallback={<div className="panel-loading-skeleton" />}>
                      <TerminalPanel />
                    </Suspense>
                  </Allotment.Pane>
                )}
              </Allotment>
            </Allotment.Pane>

            {/* Right Sidebar — File Editor / Browser Preview */}
            {rightSidebarVisible && (
              <Allotment.Pane preferredSize={rightSidebarWidth} minSize={300} maxSize={800}>
                <div className="right-sidebar">
                  <div className="sidebar-tabs">
                    <button
                      className={`sidebar-tab${rightSidebarTab === 'editor' ? ' active' : ''}`}
                      onClick={() => { setEditorMounted(true); setRightSidebarTab('editor') }}
                    >
                      文件编辑
                    </button>
                    <button
                      className={`sidebar-tab${rightSidebarTab === 'preview' ? ' active' : ''}`}
                      onClick={() => { setPreviewMounted(true); setRightSidebarTab('preview') }}
                    >
                      浏览器
                    </button>
                  </div>
                  <div className="sidebar-body">
                    {/* EditorPanel — 首次打开后 keep-alive，CSS 控制可见性 */}
                    <div style={{ display: rightSidebarTab === 'editor' ? 'flex' : 'none', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
                      {editorMounted && (
                        <Suspense fallback={<div className="panel-loading-skeleton" />}>
                          <TabBar />
                          <EditorPanel />
                        </Suspense>
                      )}
                    </div>
                    {/* PreviewPanel — 首次打开后 keep-alive */}
                    <div style={{ display: rightSidebarTab === 'preview' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
                      {previewMounted && (
                        <Suspense fallback={<div className="panel-loading-skeleton" />}>
                          <PreviewPanel />
                        </Suspense>
                      )}
                    </div>
                  </div>
                </div>
              </Allotment.Pane>
            )}
          </Allotment>
        </div>
      </div>
      {/* 拖拽分割线时覆盖全屏，阻止 Monaco/xterm mousemove 触发内部重计算，消除拖拽卡顿 */}
      {isDragging && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, cursor: 'col-resize' }} />
      )}
      <StatusBar />
      <CommandPalette />
      <ToastContainer />
      {mobileModalOpen && (
        <Suspense fallback={null}>
          <MobileConnectModal onClose={() => setMobileModalOpen(false)} />
        </Suspense>
      )}
    </div>
  )
}
