import React, { useState } from 'react'
import { useTaskStore } from '../../stores/task-store'
import { useWorkspaceStore } from '../../stores/workspace-store'

export default function TaskDetailPage(): JSX.Element {
  const viewingTask = useTaskStore((s) => s.getViewingTask)()
  const closeTaskDetail = useTaskStore((s) => s.closeTaskDetail)
  const openTask = useTaskStore((s) => s.openTask)
  const addProject = useTaskStore((s) => s.addProject)
  const removeProject = useTaskStore((s) => s.removeProject)
  const updateTask = useTaskStore((s) => s.updateTask)
  const openFolder = useWorkspaceStore((s) => s.openFolder)

  const [isAddingFolder, setIsAddingFolder] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')

  if (!viewingTask) return <></>

  const handleEnterIDE = () => {
    openTask(viewingTask.id)
  }

  const handleRenameStart = () => {
    setRenameValue(viewingTask.title)
    setIsRenaming(true)
  }

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== viewingTask.title) {
      updateTask(viewingTask.id, { title: trimmed })
    }
    setIsRenaming(false)
  }

  const handleAddFolder = async () => {
    setIsAddingFolder(true)
    try {
      const result = await window.wzxclaw.openFolder()
      if (result?.rootPath) {
        await addProject(viewingTask.id, result.rootPath)
      }
    } finally {
      setIsAddingFolder(false)
    }
  }

  const handleRemoveProject = async (projectId: string) => {
    await removeProject(viewingTask.id, projectId)
  }

  const createdDate = new Date(viewingTask.createdAt).toLocaleString()
  const updatedDate = new Date(viewingTask.updatedAt).toLocaleString()

  return (
    <div className="task-detail-page">
      <div className="task-home-dragbar" />
      {/* Header */}
      <div className="task-detail-header">
        <button className="task-detail-back" onClick={closeTaskDetail}>
          ← 返回任务列表
        </button>
        <button className="task-btn-primary task-detail-enter-btn" onClick={handleEnterIDE}>
          进入任务 →
        </button>
      </div>

      {/* Task info */}
      <div className="task-detail-body">
        <div className="task-detail-info">
          <div className="task-detail-title-row">
            {isRenaming ? (
              <input
                className="task-detail-rename-input"
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
              <h1 className="task-detail-title">{viewingTask.title}</h1>
            )}
            {!isRenaming && (
              <button className="task-card-btn" title="重命名" onClick={handleRenameStart}>
                ✎
              </button>
            )}
          </div>
          {viewingTask.description && (
            <p className="task-detail-description">{viewingTask.description}</p>
          )}
          <div className="task-detail-meta">
            <span>创建于 {createdDate}</span>
            <span>最后更新 {updatedDate}</span>
          </div>
        </div>

        {/* Projects (folders) */}
        <div className="task-detail-section">
          <div className="task-detail-section-header">
            <h2 className="task-detail-section-title">绑定的文件夹</h2>
            <button
              className="task-btn-secondary"
              onClick={handleAddFolder}
              disabled={isAddingFolder}
            >
              {isAddingFolder ? '选择中...' : '+ 添加文件夹'}
            </button>
          </div>

          {viewingTask.projects.length === 0 ? (
            <div className="task-detail-empty">
              还没有绑定文件夹。点击「添加文件夹」选择项目目录。
            </div>
          ) : (
            <ul className="task-detail-projects">
              {viewingTask.projects.map((project) => (
                <li key={project.id} className="task-detail-project-item">
                  <div className="task-detail-project-info">
                    <span className="task-detail-project-name">{project.name}</span>
                    <span className="task-detail-project-path">{project.path}</span>
                  </div>
                  <button
                    className="task-card-btn task-card-btn-danger"
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
