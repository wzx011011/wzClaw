import React, { useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useChatStore } from '../../stores/chat-store'
import FileExplorer from './FileExplorer'
import SessionList from '../chat/SessionList'

/**
 * Sidebar — left panel with two tabs: file explorer and session management.
 */
export default function Sidebar(): JSX.Element {
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const isLoading = useWorkspaceStore((s) => s.isLoading)
  const openFolder = useWorkspaceStore((s) => s.openFolder)
  const [activeTab, setActiveTab] = useState<'explorer' | 'sessions'>('explorer')

  // Extract workspace folder name from rootPath
  const workspaceName = rootPath ? rootPath.replace(/\\/g, '/').split('/').pop() : null

  return (
    <div className="sidebar">
      {/* Tabs: 资源管理器 / 会话管理 */}
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab${activeTab === 'explorer' ? ' active' : ''}`}
          onClick={() => setActiveTab('explorer')}
        >
          资源管理器
        </button>
        <button
          className={`sidebar-tab${activeTab === 'sessions' ? ' active' : ''}`}
          onClick={() => setActiveTab('sessions')}
        >
          会话管理
        </button>
      </div>
      {/* Tab content */}
      <div className="sidebar-content">
        {activeTab === 'explorer' ? (
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
            <SessionList isOpen={true} onToggle={() => {}} />
          </div>
        )}
      </div>
    </div>
  )
}
