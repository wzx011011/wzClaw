import { useState } from 'react'
import type { SessionMeta, Workspace } from '../../data-source/types'

interface WorkspaceCardProps {
  workspace: Workspace
  sessions?: SessionMeta[]
  onOpen(workspaceId: string): void
  onRename(workspaceId: string, title: string): void
  onArchive(workspaceId: string): void
  onDelete(workspaceId: string): void
}

export default function WorkspaceCard({ workspace, sessions, onOpen, onRename, onArchive, onDelete }: WorkspaceCardProps): React.ReactElement {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(workspace.title)

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== workspace.title) {
      onRename(workspace.id, trimmed)
    }
    setIsRenaming(false)
  }

  return (
    <article className="workspace-card" onClick={() => onOpen(workspace.id)}>
      <div className="workspace-card-header">
        <div className="workspace-card-title-group">
          {isRenaming ? (
            <input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRenameSubmit(); if (e.key === 'Escape') setIsRenaming(false) }}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <h3 onDoubleClick={(e) => { e.stopPropagation(); setIsRenaming(true) }}>{workspace.title}</h3>
          )}
          {workspace.description && <p>{workspace.description}</p>}
        </div>
        <div className="workspace-card-actions" onClick={(event) => event.stopPropagation()}>
          <button title="重命名" onClick={() => setIsRenaming(true)}>✎</button>
          <button title={workspace.archived ? '恢复' : '归档'} onClick={() => onArchive(workspace.id)}>
            {workspace.archived ? '↺' : '□'}
          </button>
          {confirmDelete ? (
            <span className="workspace-delete-confirm">
              <button className="confirm" onClick={() => { onDelete(workspace.id); setConfirmDelete(false) }}>确认</button>
              <button onClick={() => setConfirmDelete(false)}>取消</button>
            </span>
          ) : (
            <button title="删除" onClick={() => setConfirmDelete(true)}>×</button>
          )}
        </div>
      </div>

      <div className="workspace-card-projects">
        {workspace.projects.length === 0 ? (
          <span>未绑定项目</span>
        ) : workspace.projects.slice(0, 3).map(project => (
          <span key={project.id} title={project.path}>{project.name}</span>
        ))}
        {workspace.projects.length > 3 && <span>+{workspace.projects.length - 3}</span>}
      </div>

      {sessions && sessions.length > 0 && (
        <div className="workspace-card-sessions">
          {sessions.slice(0, 3).map(session => (
            <span key={session.id}>{session.title || session.preview || '新会话'}</span>
          ))}
        </div>
      )}
    </article>
  )
}
