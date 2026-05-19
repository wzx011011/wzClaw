// ============================================================
// WorkspaceDetailPage — 工作区详情页
//
// 显示单个工作区：基本信息、项目路径列表、会话历史、关联 Hand。
// 从 WorkspaceHomePage 导航过来（openWorkspaceDetail 之后）。
// ============================================================

import React, { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useHandStore } from '../../stores/hand-store'
import type { StoreApi } from 'zustand'
import type { ChatStore } from '../../stores/chat-store'

interface WorkspaceDetailPageProps {
  workspaceId: string
  chatStore: StoreApi<ChatStore>
  onBack: () => void
  onEnterChat: () => void
}

export default function WorkspaceDetailPage({
  workspaceId,
  chatStore,
  onBack,
  onEnterChat,
}: WorkspaceDetailPageProps): React.ReactElement {
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const sessions = useWorkspaceStore((s) => s.workspaceSessions[workspaceId] ?? [])
  const loadWorkspaceSessions = useWorkspaceStore((s) => s.loadWorkspaceSessions)
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace)
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const addProject = useWorkspaceStore((s) => s.addProject)
  const removeProject = useWorkspaceStore((s) => s.removeProject)

  const hands = useHandStore((s) => s.hands)
  const selectedHandId = useHandStore((s) => s.selectedHandId)
  const selectHand = useHandStore((s) => s.selectHand)

  const [editTitle, setEditTitle] = useState(workspace?.title ?? '')
  const [editDesc, setEditDesc] = useState(workspace?.description ?? '')
  const [editing, setEditing] = useState(false)
  const [newProjectPath, setNewProjectPath] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    loadWorkspaceSessions(workspaceId)
  }, [workspaceId, loadWorkspaceSessions])

  useEffect(() => {
    if (workspace) {
      setEditTitle(workspace.title)
      setEditDesc(workspace.description ?? '')
    }
  }, [workspace])

  if (!workspace) {
    return (
      <div style={{ padding: 'var(--sp-4)', color: 'var(--text-secondary)' }}>
        工作区不存在
        <button onClick={onBack} style={{ marginLeft: 12 }}>返回</button>
      </div>
    )
  }

  const handleSaveInfo = async () => {
    if (!editTitle.trim()) return
    setSaving(true)
    try {
      await updateWorkspace(workspaceId, {
        title: editTitle.trim(),
        description: editDesc.trim() || undefined,
      })
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  const handleAddProject = async () => {
    if (!newProjectPath.trim()) return
    await addProject(workspaceId, newProjectPath.trim())
    setNewProjectPath('')
  }

  const handleEnterSession = async (sessionId: string) => {
    setActiveWorkspace(workspaceId)
    await chatStore.getState().switchSession(sessionId)
    onEnterChat()
  }

  const handleNewSession = async () => {
    setActiveWorkspace(workspaceId)
    await chatStore.getState().createSession({ workspaceId, title: workspace.title })
    onEnterChat()
  }

  const handleDelete = async () => {
    if (!window.confirm(`确认删除工作区「${workspace.title}」及其所有配置？`)) return
    await deleteWorkspace(workspaceId)
    onBack()
  }

  return (
    <div className="workspace-page" style={{ maxWidth: 800, margin: '0 auto' }}>
      {/* 顶部返回 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 'var(--sp-4)' }}>
        <button
          onClick={onBack}
          className="settings-back-btn"
        >
          ← 返回
        </button>
        <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 'var(--font-size-lg)' }}>
          {workspace.title}
        </h2>
        {workspace.archived && (
          <span style={{
            fontSize: 11,
            padding: '2px 8px',
            background: 'var(--text-muted)',
            color: '#fff',
            borderRadius: 10,
          }}>已归档</span>
        )}
      </div>

      {/* 基本信息卡片 */}
      <div className="settings-card" style={{ marginBottom: 'var(--sp-3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--sp-3)' }}>
          <h3 className="settings-section-title" style={{ margin: 0 }}>基本信息</h3>
          <button
            onClick={() => setEditing(!editing)}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 12,
              padding: '3px 10px',
            }}
          >
            {editing ? '取消' : '编辑'}
          </button>
        </div>

        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
            <div className="settings-field">
              <label className="settings-label">名称</label>
              <input
                className="settings-input"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
              />
            </div>
            <div className="settings-field">
              <label className="settings-label">描述</label>
              <input
                className="settings-input"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="可选"
              />
            </div>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
              <button onClick={handleSaveInfo} disabled={saving} className="settings-save-btn">
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {workspace.description || <span style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>暂无描述</span>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              创建于 {new Date(workspace.createdAt).toLocaleString()}
              {workspace.updatedAt && workspace.updatedAt !== workspace.createdAt && (
                <> · 更新于 {new Date(workspace.updatedAt).toLocaleString()}</>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 项目路径 */}
      {workspace.projects !== undefined && (
        <div className="settings-card" style={{ marginBottom: 'var(--sp-3)' }}>
          <h3 className="settings-section-title">项目路径</h3>
          {workspace.projects.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 'var(--sp-2)' }}>暂无关联项目</div>
          )}
          {workspace.projects.map((proj) => (
            <div key={proj.id} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 0',
              borderBottom: '1px solid var(--border-subtle)',
            }}>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                {proj.path}
              </span>
              <button
                onClick={() => removeProject(workspaceId, proj.id)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--tool-error, #ef4444)',
                  cursor: 'pointer',
                  fontSize: 13,
                  padding: '0 4px',
                }}
              >
                ×
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' }}>
            <input
              className="settings-input"
              style={{ flex: 1 }}
              value={newProjectPath}
              onChange={(e) => setNewProjectPath(e.target.value)}
              placeholder="输入项目路径..."
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddProject() }}
            />
            <button onClick={handleAddProject} className="settings-save-btn">添加</button>
          </div>
        </div>
      )}

      {/* 关联 Hand */}
      {hands.length > 0 && (
        <div className="settings-card" style={{ marginBottom: 'var(--sp-3)' }}>
          <h3 className="settings-section-title">关联 Hand</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
            {hands.map((hand) => (
              <div key={hand.id} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 0',
              }}>
                <span style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)' }}>{hand.id}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hand.type}</span>
                {selectedHandId === hand.id ? (
                  <span style={{ fontSize: 11, color: 'var(--accent)' }}>当前</span>
                ) : (
                  <button
                    onClick={() => selectHand(hand.id)}
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                      fontSize: 11,
                      padding: '2px 8px',
                    }}
                  >
                    选择
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 会话历史 */}
      <div className="settings-card" style={{ marginBottom: 'var(--sp-3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--sp-3)' }}>
          <h3 className="settings-section-title" style={{ margin: 0 }}>会话历史</h3>
          <button onClick={handleNewSession} className="settings-save-btn" style={{ fontSize: 12, padding: '4px 12px' }}>
            新建会话
          </button>
        </div>
        {sessions.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>暂无会话记录</div>
        )}
        {sessions.slice(0, 20).map((session) => (
          <div
            key={session.id}
            onClick={() => handleEnterSession(session.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 0',
              borderBottom: '1px solid var(--border-subtle)',
              cursor: 'pointer',
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                {session.title || '未命名会话'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                {new Date(session.updatedAt ?? session.createdAt).toLocaleString()}
                {session.messageCount > 0 && <> · {session.messageCount} 条消息</>}
              </div>
            </div>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </div>
        ))}
      </div>

      {/* 危险操作 */}
      <div className="settings-card" style={{ borderColor: 'var(--tool-error, #ef4444)' }}>
        <h3 className="settings-section-title" style={{ color: 'var(--tool-error, #ef4444)' }}>危险操作</h3>
        <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
          {!workspace.archived && (
            <button
              onClick={() => updateWorkspace(workspaceId, { archived: true })}
              style={{
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                padding: '6px 14px',
                fontSize: 13,
              }}
            >
              归档工作区
            </button>
          )}
          <button
            onClick={handleDelete}
            style={{
              background: 'transparent',
              border: '1px solid var(--tool-error, #ef4444)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--tool-error, #ef4444)',
              cursor: 'pointer',
              padding: '6px 14px',
              fontSize: 13,
            }}
          >
            删除工作区
          </button>
        </div>
      </div>
    </div>
  )
}
