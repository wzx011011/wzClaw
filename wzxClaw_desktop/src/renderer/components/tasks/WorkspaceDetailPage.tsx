import React, { useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useWorkspaceStore } from '../../stores/workspace-store'

export default function WorkspaceDetailPage(): JSX.Element {
  const viewingWorkspace = useWorkspaceStore((s) => s.getViewingWorkspace)()
  const closeWorkspaceDetail = useWorkspaceStore((s) => s.closeWorkspaceDetail)
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace)
  const addProject = useWorkspaceStore((s) => s.addProject)
  const removeProject = useWorkspaceStore((s) => s.removeProject)
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace)
  const openFolder = useWorkspaceStore((s) => s.openFolder)

  const [isAddingFolder, setIsAddingFolder] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')

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

  const createdDate = new Date(viewingWorkspace.createdAt).toLocaleString()
  const updatedDate = new Date(viewingWorkspace.updatedAt).toLocaleString()

  return (
    <div className="workspace-detail-page">
      <div className="workspace-home-dragbar" />
      {/* Header */}
      <div className="workspace-detail-header">
        <button className="workspace-detail-back" onClick={closeWorkspaceDetail}>
          ← 返回工作区列表
        </button>
        <button className="workspace-btn-primary workspace-detail-enter-btn" onClick={handleEnterIDE}>
          进入工作区 →
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
              <button className="workspace-card-btn" title="重命名" onClick={handleRenameStart}>
                ✎
              </button>
            )}
          </div>
          {viewingWorkspace.description && (
            <p className="workspace-detail-description">{viewingWorkspace.description}</p>
          )}
          <div className="workspace-detail-meta">
            <span>创建于 {createdDate}</span>
            <span>最后更新 {updatedDate}</span>
          </div>
        </div>

        {/* Projects (folders) */}
        <div className="workspace-detail-section">
          <div className="workspace-detail-section-header">
            <h2 className="workspace-detail-section-title">绑定的文件夹</h2>
            <button
              className="workspace-btn-secondary"
              onClick={handleAddFolder}
              disabled={isAddingFolder}
            >
              {isAddingFolder ? '选择中...' : '+ 添加文件夹'}
            </button>
          </div>

          {viewingWorkspace.projects.length === 0 ? (
            <div className="workspace-detail-empty">
              还没有绑定文件夹。点击「添加文件夹」选择项目目录。
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
                    title="移除文件夹"
                    onClick={() => handleRemoveProject(project.id)}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
