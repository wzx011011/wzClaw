// ============================================================
// IDELayout — IDE 主布局
//
// ActivityBar + Sidebar(FileExplorer) + ChatPanel + TerminalPanel
// + EditorPanel + PreviewPanel + StatusBar
//
// 基于 CSS Grid/Flex 布局，不依赖 Allotment。
// capability-driven：根据 useCapabilities 隐藏不可用区域。
// ============================================================

import React, { useEffect } from 'react'
import type { StoreApi } from 'zustand'
import type { ChatStore } from '../../stores/chat-store'
import { useCapabilities } from '../../hooks/useCapabilities'
import { useDataSource } from '../../providers/DataSourceProvider'
import { useLayoutStore } from '../../stores/layout-store'
import { useTerminalStore } from '../../stores/terminal-store'
import ActivityBar from './ActivityBar'
import Sidebar from './Sidebar'
import EditorPanel from './EditorPanel'
import TerminalPanel from './TerminalPanel'
import PreviewPanel from './PreviewPanel'
import StatusBar from './StatusBar'

interface IDELayoutProps {
  chatStore: StoreApi<ChatStore>
  connected: boolean
}

export default function IDELayout({ chatStore }: IDELayoutProps): React.ReactElement {
  const dataSource = useDataSource()
  const caps = useCapabilities(dataSource)
  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible)
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth)
  const bottomPanelVisible = useLayoutStore((s) => s.bottomPanelVisible)
  const bottomPanelHeight = useLayoutStore((s) => s.bottomPanelHeight)
  const rightSidebarVisible = useLayoutStore((s) => s.rightSidebarVisible)
  const rightSidebarWidth = useLayoutStore((s) => s.rightSidebarWidth)

  const terminalPanelVisible = useTerminalStore((s) => s.panelVisible)
  // 全局快捷键
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl+B 切换侧边栏
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault()
        useLayoutStore.getState().toggleSidebar()
      }
      // Ctrl+` 切换终端
      if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault()
        useTerminalStore.getState().togglePanel()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
      overflow: 'hidden',
    }}>
      {/* 主体区域 */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* ActivityBar */}
        <ActivityBar />

        {/* Sidebar */}
        {sidebarVisible && (
          <div style={{
            width: sidebarWidth,
            flexShrink: 0,
            borderRight: '1px solid var(--border)',
            overflow: 'hidden',
          }}>
            <Sidebar chatStore={chatStore} />
          </div>
        )}

        {/* 中央区域：编辑器 + 聊天 + 终端 */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
        }}>
          {/* 上半部分：编辑器 */}
          {caps.localEditor ? (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <EditorPanel />
            </div>
          ) : (
            <div style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-secondary)',
              fontSize: 'var(--font-size-sm)',
            }}>
              编辑器仅在桌面端可用
            </div>
          )}

          {/* 下半部分：终端 */}
          {caps.terminal && (bottomPanelVisible || terminalPanelVisible) && (
            <div style={{
              height: bottomPanelHeight,
              flexShrink: 0,
              borderTop: '1px solid var(--border)',
              overflow: 'hidden',
            }}>
              <TerminalPanel />
            </div>
          )}
        </div>

        {/* 右侧：预览 */}
        {caps.preview && rightSidebarVisible && (
          <div style={{
            width: rightSidebarWidth,
            flexShrink: 0,
            borderLeft: '1px solid var(--border)',
            overflow: 'hidden',
          }}>
            <PreviewPanel />
          </div>
        )}
      </div>

      {/* 底部状态栏 */}
      <StatusBar />
    </div>
  )
}
