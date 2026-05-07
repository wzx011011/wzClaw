import React, { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useChatStore } from '../../stores/chat-store'
import { useT } from '../../i18n/useT'

export default function WorkspaceDetailPage(): JSX.Element {
  const t = useT()
  const viewingWorkspace = useWorkspaceStore((s) => s.getViewingWorkspace)()
  const sessions = useWorkspaceStore((s) => viewingWorkspace ? s.workspaceSessions[viewingWorkspace.id] : undefined)
  const closeWorkspaceDetail = useWorkspaceStore((s) => s.closeWorkspaceDetail)
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace)
  const addProject = useWorkspaceStore((s) => s.addProject)
  const removeProject = useWorkspaceStore((s) => s.removeProject)
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace)
  const switchSession = useChatStore((s) => s.switchSession)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)

  const [isAddingFolder, setIsAddingFolder] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')

  // Load sessions when viewing a workspace
  useEffect(() => {
    if (viewingWorkspace) {
      useWorkspaceStore.getState().loadWorkspaceSessions(viewingWorkspace.id)
    }
  }, [viewingWorkspace?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!viewingWorkspace) return <></>

  const handleEnterIDE = () => {
    openWorkspace(viewingWorkspace.id)
  }

  const handleRenameStart = () => {
    setRenameValue(viewingWorkspace.title)
    setIsRenaming(true)
  }

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== viewingWorkspace.title) {
      updateWorkspace(viewingWorkspace.id, { title: trimmed })
    }
    setIsRenaming(false)
  }

  const handleAddFolder = async () => {
    setIsAddingFolder(true)
    try {
      const result = await window.wzxclaw.openFolder()
      if (result?.rootPath) {
        await addProject(viewingWorkspace.id, result.rootPath)
      }
    } finally {
      setIsAddingFolder(false)
    }
  }

  const handleRemoveProject = async (projectId: string) => {
    await removeProject(viewingWorkspace.id, projectId)
  }

  const handleOpenSession = async (sessionId: string) => {
    // First enter the workspace if not already active
    if (activeWorkspaceId !== viewingWorkspace.id) {
      openWorkspace(viewingWorkspace.id)
    }
    // Then switch to the session
    await switchSession(sessionId)
  }

  const createdDate = new Date(viewingWorkspace.createdAt).toLocaleString()
  const updatedDate = new Date(viewingWorkspace.updatedAt).toLocaleString()

  return (
    <div className="workspace-detail-page">
      <div className="workspace-home-dragbar" />
      {/* Header */}
      <div className="workspace-detail-header">
        <button className="workspace-detail-back" onClick={closeWorkspaceDetail}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
          {t('workspaceDetail.backToList')}
        </button>
        <button className="workspace-btn-primary workspace-detail-enter-btn" onClick={handleEnterIDE}>
          {t('workspaceDetail.enterWorkspace')} <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
        </button>
      </div>

      {/* Workspace info */}
      <div className="workspace-detail-body">
        <div className="workspace-detail-info">
          <div className="workspace-detail-title-row">
            {isRenaming ? (
              <input
                className="workspace-detail-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={handleRenameSubmit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameSubmit()
                  if (e.key === 'Escape') setIsRenaming(false)
                }}
                autoFocus
              />
            ) : (
              <h1 className="workspace-detail-title">{viewingWorkspace.title}</h1>
            )}
            {!isRenaming && (
              <button className="workspace-card-btn" title={t('workspaceDetail.rename')} onClick={handleRenameStart}>
                ✎
              </button>
            )}
          </div>
          {viewingWorkspace.description && (
            <p className="workspace-detail-description">{viewingWorkspace.description}</p>
          )}
          <div className="workspace-detail-meta">
            <span>{t('workspaceDetail.createdAt')} {createdDate}</span>
            <span>{t('workspaceDetail.lastUpdated')} {updatedDate}</span>
          </div>
        </div>

        {/* Projects (folders) */}
        <div className="workspace-detail-section">
          <div className="workspace-detail-section-header">
            <h2 className="workspace-detail-section-title">{t('workspaceDetail.boundFolders')}</h2>
            <button
              className="workspace-btn-secondary"
              onClick={handleAddFolder}
              disabled={isAddingFolder}
            >
              {isAddingFolder ? t('workspaceDetail.selecting') : `+ ${t('workspaceDetail.addFolder')}`}
            </button>
          </div>

          {viewingWorkspace.projects.length === 0 ? (
            <div className="workspace-detail-empty">
              {t('workspaceDetail.noFolders')}
            </div>
          ) : (
            <ul className="workspace-detail-projects">
              {viewingWorkspace.projects.map((project) => (
                <li key={project.id} className="workspace-detail-project-item">
                  <div className="workspace-detail-project-info">
                    <span className="workspace-detail-project-name">{project.name}</span>
                    <span className="workspace-detail-project-path">{project.path}</span>
                  </div>
                  <button
                    className="workspace-card-btn workspace-card-btn-danger"
                    title={t('workspaceDetail.removeFolder')}
                    onClick={() => handleRemoveProject(project.id)}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Sessions with task status */}
        <div className="workspace-detail-section">
          <div className="workspace-detail-section-header">
            <h2 className="workspace-detail-section-title">会话</h2>
          </div>

          {!sessions || sessions.length === 0 ? (
            <div className="workspace-detail-empty">
              暂无会话
            </div>
          ) : (
            <ul className="workspace-detail-sessions">
              {sessions.map((session) => (
                <li
                  key={session.id}
                  className="workspace-detail-session-item"
                  role="button"
                  tabIndex={0}
                  onClick={() => handleOpenSession(session.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleOpenSession(session.id) } }}
                >
                  <div className="workspace-detail-session-info">
                    <div className="workspace-detail-session-title-row">
                      <span className={`workspace-detail-session-dot${session.isRunning ? ' running' : ''}`} />
                      <span className="workspace-detail-session-title">
                        {session.title || session.preview || '新会话'}
                      </span>
                      {session.isRunning && (
                        <span className="workspace-detail-session-badge running">运行中</span>
                      )}
                    </div>
                    {session.todoSummary && (
                      <div className="workspace-detail-session-todo">
                        📊 {session.todoSummary}
                      </div>
                    )}
                    <div className="workspace-detail-session-meta">
                      <span>{session.messageCount} 条消息</span>
                      <span>{new Date(session.updatedAt).toLocaleString()}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
