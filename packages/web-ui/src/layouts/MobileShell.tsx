// ============================================================
// MobileShell — 移动端专用布局容器
//
// 结构：TopBar（固定顶部）+ Tab 内容区（可滚动）
//       + FloatingBar（浮动通知）+ BottomTabBar（固定底部）
// Tab: chat / files / sessions / settings
// ============================================================

import React, { useState, useEffect, useRef } from 'react'
import type { StoreApi } from 'zustand'
import type { ChatStore } from '../stores/chat-store'
import type { FileBrowserStore as FileBrowserStoreType } from '../stores/file-browser-store'
import type { FileTreeNode } from '../data-source/types'
import type { DataSource } from '../data-source/types'
import ChatPanel from '../components/chat/ChatPanel'
import SessionList from '../components/chat/SessionList'
import FileBrowserPage from '../pages/mobile/FileBrowserPage'
import FileViewerPage from '../pages/mobile/FileViewerPage'
import BottomTabBar from '../components/mobile/BottomTabBar'
import TopBar from '../components/mobile/TopBar'
import FloatingBar from '../components/mobile/FloatingBar'
import DesktopPicker from '../components/mobile/DesktopPicker'
import ConnectionStatusBar from '../components/mobile/ConnectionStatusBar'
import WorkspaceHomePage from '../components/workspaces/WorkspaceHomePage'
import { useHandStore } from '../stores/hand-store'
import { createFileBrowserStore } from '../stores/file-browser-store'
import { useConnectionConfig } from '../hooks/useConnectionConfig'

type MobileTab = 'chat' | 'workspaces' | 'files' | 'sessions' | 'settings'

interface MobileShellProps {
  chatStore: StoreApi<ChatStore>
  connected: boolean
  setView: (view: 'chat' | 'ide' | 'workspaces' | 'settings') => void
  dataSource: DataSource | null
}

export default function MobileShell({ chatStore, connected, setView, dataSource }: MobileShellProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<MobileTab>('chat')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selectedFile, setSelectedFile] = useState<FileTreeNode | null>(null)
  const { hands, fetchHands } = useHandStore()
  const { config } = useConnectionConfig()

  // 文件浏览器 store（单例）
  const fileStoreRef = useRef<StoreApi<FileBrowserStoreType> | null>(null)
  if (!fileStoreRef.current && dataSource?.fs) {
    fileStoreRef.current = createFileBrowserStore(dataSource.fs)
  }
  const fileStore = fileStoreRef.current

  // 定期刷新 Hand 列表
  useEffect(() => {
    if (!config.agentUrl) return
    fetchHands(config.agentUrl, config.token || undefined)
    const timer = setInterval(() => fetchHands(config.agentUrl, config.token || undefined), 30000)
    return () => clearInterval(timer)
  }, [config.agentUrl, config.token, fetchHands])

  const handleTabChange = (tab: MobileTab): void => {
    if (tab === 'settings') {
      setView('settings')
      return
    }
    setSelectedFile(null)
    setActiveTab(tab)
  }

  const activeId = chatStore.getState().activeSessionId
  const sessionTitle = activeId ? '对话' : '新对话'

  return (
    <div className="mobile-shell">
      <TopBar
        title={sessionTitle}
        connected={connected}
        showPicker={hands.length >= 2}
        onPickerOpen={() => setPickerOpen(true)}
      />
      <ConnectionStatusBar />

      <div className="mobile-tab-content">
        {activeTab === 'chat' && (
          <ChatPanel store={chatStore} connected={connected} />
        )}
        {activeTab === 'workspaces' && (
          <WorkspaceHomePage chatStore={chatStore} onEnterChat={() => setActiveTab('chat')} />
        )}
        {activeTab === 'files' && selectedFile && dataSource?.fs ? (
          <FileViewerPage
            filePath={selectedFile.path}
            fileName={selectedFile.name}
            fs={dataSource.fs}
            onBack={() => setSelectedFile(null)}
          />
        ) : activeTab === 'files' && fileStore ? (
          <FileBrowserPage
            store={fileStore}
            onFileOpen={setSelectedFile}
            hasFs={!!dataSource?.fs}
          />
        ) : activeTab === 'files' ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--text-secondary)',
            fontSize: 'var(--font-size-sm)',
            padding: 'var(--sp-4)',
            textAlign: 'center' as const,
          }}>
            文件浏览需要 Hand 连接
          </div>
        ) : null}
        {activeTab === 'sessions' && (
          <div style={{ height: '100%', overflow: 'auto' }}>
            <SessionList store={chatStore} />
          </div>
        )}
      </div>

      <FloatingBar />
      <BottomTabBar activeTab={activeTab} onTabChange={handleTabChange} />
      <DesktopPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
    </div>
  )
}
