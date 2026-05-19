// ============================================================
// Sidebar — 侧边栏容器
//
// 根据 activeSidebarPanel 切换内容：FileExplorer / SessionList
// ============================================================

import React from 'react'
import { useLayoutStore } from '../../stores/layout-store'
import FileExplorer from './FileExplorer'
import type { StoreApi } from 'zustand'
import type { ChatStore } from '../../stores/chat-store'

interface SidebarProps {
  chatStore: StoreApi<ChatStore>
}

export default function Sidebar({ chatStore: _chatStore }: SidebarProps): React.ReactElement {
  const activePanel = useLayoutStore((s) => s.activeSidebarPanel)

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {activePanel === 'explorer' && <FileExplorer />}
      {activePanel === 'sessions' && (
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {/* SessionList 复用聊天组件 */}
          {/* TODO: 从 chat/SessionList 迁移 */}
          <div style={{ padding: 'var(--sp-3)', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
            会话列表
          </div>
        </div>
      )}
      {activePanel === 'search' && (
        <div style={{ padding: 'var(--sp-3)', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
          搜索（Ctrl+K 打开命令面板）
        </div>
      )}
    </div>
  )
}
