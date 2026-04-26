import React from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useChatStore } from '../../stores/chat-store'
import FileExplorer from './FileExplorer'
import SessionList from '../chat/SessionList'
import type { SidebarPanel } from '../../stores/layout-store'

/**
 * Sidebar — 左侧面板，内容由 ActivityBar 驱动。
 * 不再自行管理 tab 切换，由父组件传入 activePanel。
 */
interface SidebarProps {
  activePanel: SidebarPanel
}

export default function Sidebar({ activePanel }: SidebarProps): JSX.Element {
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const isLoading = useWorkspaceStore((s) => s.isLoading)
  const openFolder = useWorkspaceStore((s) => s.openFolder)

  // Extract workspace folder name from rootPath
  const workspaceName = rootPath ? rootPath.replace(/\\/g, '/').split('/').pop() : null

  return (
    <div className="sidebar">
      <div className="sidebar-content">
        {activePanel === 'explorer' ? (
          !rootPath ? (
            <button className="open-folder-btn" onClick={openFolder}>
              Open Folder
            </button>
          ) : isLoading ? (
            <div className="sidebar-loading">Loading...</div>
          ) : (
            <>
              {workspaceName && (
                <div className="sidebar-project-name">{workspaceName}</div>
              )}
              <FileExplorer />
            </>
          )
        ) : (
          <div className="sidebar-sessions">
            <div className="sidebar-sessions-header">
              <span>会话列表</span>
              <button
                className="sidebar-new-session-btn"
                title="新建会话"
                onClick={() => useChatStore.getState().createSession()}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>
            <SessionList />
          </div>
        )}
      </div>
    </div>
  )
}
