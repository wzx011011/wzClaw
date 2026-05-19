import { useEffect, useMemo, useState } from 'react'
import type { StoreApi } from 'zustand'
import type { ChatStore } from '../../stores/chat-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import WorkspaceCard from './WorkspaceCard'

interface WorkspaceHomePageProps {
  chatStore: StoreApi<ChatStore>
  onEnterChat(): void
}

export default function WorkspaceHomePage({ chatStore, onEnterChat }: WorkspaceHomePageProps): React.ReactElement {
  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const sessions = useWorkspaceStore((state) => state.workspaceSessions)
  const isLoading = useWorkspaceStore((state) => state.isLoading)
  const error = useWorkspaceStore((state) => state.error)
  const viewingWorkspaceId = useWorkspaceStore((state) => state.viewingWorkspaceId)
  const loadWorkspaces = useWorkspaceStore((state) => state.loadWorkspaces)
  const loadWorkspaceSessions = useWorkspaceStore((state) => state.loadWorkspaceSessions)
  const createWorkspace = useWorkspaceStore((state) => state.createWorkspace)
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace)
  const deleteWorkspace = useWorkspaceStore((state) => state.deleteWorkspace)
  const openWorkspaceDetail = useWorkspaceStore((state) => state.openWorkspaceDetail)
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => {
    loadWorkspaces(true)
  }, [loadWorkspaces])

  useEffect(() => {
    for (const workspace of workspaces) {
      loadWorkspaceSessions(workspace.id)
    }
  }, [workspaces, loadWorkspaceSessions])

  const displayedWorkspaces = useMemo(
    () => workspaces.filter(workspace => showArchived ? workspace.archived : !workspace.archived),
    [showArchived, workspaces],
  )

  const handleCreate = async () => {
    const trimmed = title.trim()
    if (!trimmed) return
    const workspace = await createWorkspace(trimmed, description.trim() || undefined)
    setTitle('')
    setDescription('')
    openWorkspaceDetail(workspace.id)
  }

  const handleEnterWorkspace = async (workspaceId: string) => {
    const workspace = workspaces.find(item => item.id === workspaceId)
    if (!workspace) return
    setActiveWorkspace(workspaceId)
    if (workspace.lastSessionId) {
      await chatStore.getState().switchSession(workspace.lastSessionId)
    } else {
      await chatStore.getState().createSession({ workspaceId, title: workspace.title })
      const sessionId = chatStore.getState().activeSessionId ?? chatStore.getState().conversationId
      await updateWorkspace(workspaceId, { lastSessionId: sessionId }).catch(() => workspace)
    }
    onEnterChat()
  }

  return (
    <main className="workspace-page">
      <section className="workspace-toolbar">
        <div>
          <h1>工作区</h1>
          <p>把项目、会话和专属提示词绑定到同一个工作上下文。</p>
        </div>
        <button onClick={() => setShowArchived(value => !value)}>
          {showArchived ? '显示活跃' : '显示归档'}
        </button>
      </section>

      <section className="workspace-create-panel">
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="工作区名称" />
        <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述，可选" />
        <button onClick={handleCreate}>新建</button>
      </section>

      {error && <div className="workspace-error">{error}</div>}

      {isLoading ? (
        <div className="workspace-empty">加载中...</div>
      ) : displayedWorkspaces.length === 0 ? (
        <div className="workspace-empty">暂无工作区</div>
      ) : (
        <div className="workspace-grid">
          {displayedWorkspaces.map(workspace => (
            <WorkspaceCard
              key={workspace.id}
              workspace={workspace}
              sessions={sessions[workspace.id]}
              onOpen={openWorkspaceDetail}
              onRename={(workspaceId, title) => updateWorkspace(workspaceId, { title })}
              onArchive={(workspaceId) => updateWorkspace(workspaceId, { archived: !workspace.archived })}
              onDelete={deleteWorkspace}
            />
          ))}
        </div>
      )}

      {viewingWorkspaceId && (
        <WorkspaceDetailPanel onEnterWorkspace={handleEnterWorkspace} />
      )}
    </main>
  )
}

function WorkspaceDetailPanel({ onEnterWorkspace }: { onEnterWorkspace(workspaceId: string): Promise<void> }): React.ReactElement | null {
  const workspace = useWorkspaceStore((state) => state.getViewingWorkspace())
  const closeWorkspaceDetail = useWorkspaceStore((state) => state.closeWorkspaceDetail)
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace)
  const addProject = useWorkspaceStore((state) => state.addProject)
  const removeProject = useWorkspaceStore((state) => state.removeProject)
  const sessions = useWorkspaceStore((state) => workspace ? state.workspaceSessions[workspace.id] : undefined)
  const [folderPath, setFolderPath] = useState('')
  const [systemPrompt, setSystemPrompt] = useState(workspace?.systemPrompt ?? '')

  useEffect(() => {
    setSystemPrompt(workspace?.systemPrompt ?? '')
  }, [workspace?.id, workspace?.systemPrompt])

  if (!workspace) return null

  const handleAddProject = async () => {
    const trimmed = folderPath.trim()
    if (!trimmed) return
    await addProject(workspace.id, trimmed)
    setFolderPath('')
  }

  const handleBrowseFolder = async () => {
    // 桌面 Electron 模式使用 native folder picker
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any
    if (typeof window !== 'undefined' && w.wzxclaw) {
      const pickFolder = w.wzxclaw.pickFolder as (() => Promise<string>) | undefined
      if (pickFolder) {
        try {
          const path = await pickFolder()
          if (path) {
            await addProject(workspace.id, path)
          }
          return
        } catch { /* fallback to manual input */ }
      }
    }
    // Web/手机端：手动输入路径（已由 input 提供）
  }

  return (
    <aside className="workspace-detail-panel">
      <div className="workspace-detail-header">
        <button onClick={closeWorkspaceDetail}>←</button>
        <h2>{workspace.title}</h2>
        <button onClick={() => onEnterWorkspace(workspace.id)}>进入</button>
      </div>

      <div className="workspace-detail-section">
        <label>项目路径</label>
        <div className="workspace-inline-form">
          <input value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="例如 /volume1/code/app 或 E:\\code\\app" />
          <button onClick={handleBrowseFolder}>浏览</button>
          <button onClick={handleAddProject}>添加</button>
        </div>
        <div className="workspace-project-list">
          {workspace.projects.length === 0 ? <span>未绑定项目</span> : workspace.projects.map(project => (
            <div key={project.id} className="workspace-project-row">
              <div>
                <strong>{project.name}</strong>
                <span>{project.path}</span>
              </div>
              <button onClick={() => removeProject(workspace.id, project.id)}>移除</button>
            </div>
          ))}
        </div>
      </div>

      <div className="workspace-detail-section">
        <label>系统提示词</label>
        <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={5} />
        <button onClick={() => updateWorkspace(workspace.id, { systemPrompt: systemPrompt || undefined })}>保存提示词</button>
      </div>

      <div className="workspace-detail-section">
        <label>会话</label>
        <div className="workspace-session-list">
          {!sessions || sessions.length === 0 ? <span>暂无会话</span> : sessions.map(session => (
            <span key={session.id}>{session.title || session.preview || '新会话'}</span>
          ))}
        </div>
      </div>
    </aside>
  )
}