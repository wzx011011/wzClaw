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
  const [showSystemPrompt, setShowSystemPrompt] = useState(false)
  const [systemPromptValue, setSystemPromptValue] = useState(viewingWorkspace?.systemPrompt || '')
  const [systemPromptSaved, setSystemPromptSaved] = useState(true)

  // 同步 workspace 的 systemPrompt 到本地编辑状态
  useEffect(() => {
    if (viewingWorkspace) {
      setSystemPromptValue(viewingWorkspace.systemPrompt || '')
      setSystemPromptSaved(true)
    }
  }, [viewingWorkspace?.systemPrompt]) // eslint-disable-line react-hooks/exhaustive-deps

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

        {/* System Prompt — 工作区级系统提示词覆盖 */}
        <div className="workspace-detail-section">
          <div className="workspace-detail-section-header">
            <h2 className="workspace-detail-section-title">
              系统提示词
              {!viewingWorkspace.systemPrompt && (
                <span className="workspace-detail-hint">（使用全局设置）</span>
              )}
            </h2>
            <button
              className="workspace-btn-secondary"
              onClick={() => setShowSystemPrompt(!showSystemPrompt)}
            >
              {showSystemPrompt ? '收起' : '自定义'}
            </button>
          </div>

          {showSystemPrompt && (
            <div className="workspace-detail-system-prompt">
              {/* 快捷模板 */}
              <div className="workspace-detail-prompt-templates">
                {[
                  { label: '通用编程', value: '' },
                  { label: '服务器管理', value: '你是一个 Linux 服务器管理助手，通过 SSH 管理远程主机。擅长系统监控、Docker 容器管理、故障排查、性能优化。回复时使用简洁的命令和建议，必要时提供完整的命令行操作步骤。' },
                  { label: '代码审查', value: '你是一个代码审查专家。专注于代码质量、安全漏洞、性能优化和最佳实践。审查时指出具体问题、提供修复建议，并按严重程度分类（HIGH/MEDIUM/LOW）。' },
                  { label: '前端专家', value: '你是一个前端开发专家，精通 React、TypeScript、CSS。专注于组件设计、状态管理、性能优化和用户体验。代码风格遵循函数式组件 + Hooks 模式。' },
                ].map(tpl => (
                  <button
                    key={tpl.label}
                    className={`workspace-btn-secondary workspace-detail-template-btn${systemPromptValue === tpl.value ? ' active' : ''}`}
                    onClick={() => {
                      setSystemPromptValue(tpl.value)
                      setSystemPromptSaved(false)
                    }}
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>

              <textarea
                className="workspace-detail-prompt-textarea"
                value={systemPromptValue}
                onChange={(e) => {
                  setSystemPromptValue(e.target.value)
                  setSystemPromptSaved(false)
                }}
                placeholder="留空则使用全局系统提示词。输入自定义提示词让 AI 在此工作区中扮演特定角色..."
                rows={5}
              />
              <div className="workspace-detail-prompt-actions">
                <button
                  className="workspace-btn-primary"
                  disabled={systemPromptSaved}
                  onClick={() => {
                    updateWorkspace(viewingWorkspace.id, { systemPrompt: systemPromptValue || undefined })
                    setSystemPromptSaved(true)
                  }}
                >
                  保存
                </button>
                {viewingWorkspace.systemPrompt && (
                  <button
                    className="workspace-btn-secondary"
                    onClick={() => {
                      setSystemPromptValue('')
                      updateWorkspace(viewingWorkspace.id, { systemPrompt: undefined })
                    }}
                  >
                    恢复默认
                  </button>
                )}
              </div>
            </div>
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
