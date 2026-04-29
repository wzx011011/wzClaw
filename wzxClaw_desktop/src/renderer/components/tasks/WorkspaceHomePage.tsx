import React, { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import WorkspaceCard from './WorkspaceCard'
import CreateWorkspaceModal from './CreateTaskModal'
import MobileConnectModal from '../ide/MobileConnectModal'

type ThemeMode = 'midnight' | 'dark' | 'light'

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: 'midnight', label: 'Midnight' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
]

interface MobileDevice {
  deviceId: string
  name: string | null
  platform: string | null
  osVersion: string | null
  appVersion: string | null
  connectedAt: number
}

interface RelayStatus {
  connected: boolean
  connecting: boolean
  reconnectAttempt: number
  mobileConnected: boolean
  mobileIdentity: string | null
  mobiles: MobileDevice[]
}

function formatConnectedAt(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

export default function WorkspaceHomePage(): JSX.Element {
  const tasks = useWorkspaceStore((s) => s.tasks)
  const isLoading = useWorkspaceStore((s) => s.isLoading)
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces)
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace)
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace)
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace)
  const openWorkspaceDetail = useWorkspaceStore((s) => s.openWorkspaceDetail)

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null)
  const [showMobileModal, setShowMobileModal] = useState(false)
  const [currentTheme, setCurrentTheme] = useState<ThemeMode>(
    () => (document.documentElement.getAttribute('data-theme') as ThemeMode) || 'midnight'
  )

  useEffect(() => {
    loadWorkspaces()
  }, [loadWorkspaces])

  useEffect(() => {
    window.wzxclaw.getRelayStatus().then(setRelayStatus)
    const unsubRelay = window.wzxclaw.onRelayStatus(setRelayStatus)
    return () => { unsubRelay() }
  }, [])

  const applyTheme = (theme: ThemeMode) => {
    setCurrentTheme(theme)
    document.documentElement.setAttribute('data-theme', theme)
    const overlayColors = theme === 'light'
      ? { color: '#f5f5f5', symbolColor: '#333333' }
      : { color: '#181818', symbolColor: '#e0e0e0' }
    window.wzxclaw.setTitleBarOverlay?.(overlayColors)
  }

  const activeWorkspaces = tasks.filter((t) => !t.archived)
  const archivedWorkspaces = tasks.filter((t) => t.archived)
  const displayWorkspaces = showArchived ? archivedWorkspaces : activeWorkspaces

  const handleCreate = async (title: string, description?: string) => {
    const task = await createWorkspace(title, description)
    setShowCreateModal(false)
    openWorkspaceDetail(task.id)
  }

  const handleArchive = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId)
    if (task) {
      updateWorkspace(taskId, { archived: !task.archived })
    }
  }

  const handleDelete = (taskId: string) => {
    // \u5220\u9664\u786e\u8ba4\u73b0\u5728\u5728 WorkspaceCard \u5185\u8054\u5b8c\u6210\uff0c\u907f\u514d\u539f\u751f confirm() \u7a81\u5151\u7684\u4f53\u9a8c\n    deleteWorkspace(taskId)
  }

  const handleRename = (taskId: string, newTitle: string) => {
    updateWorkspace(taskId, { title: newTitle })
  }

  const handleDisconnectRelay = async () => {
    await window.wzxclaw.disconnectRelay()
  }

  // Relay connection state
  const relayConnected = relayStatus?.connected ?? false
  const relayConnecting = relayStatus?.connecting ?? false
  const mobiles = relayStatus?.mobiles ?? []

  return (
    <div className="workspace-home">
      <div className="workspace-home-dragbar" />
      <div className="workspace-home-header">
        <h1 className="workspace-home-title">工作区</h1>
        <div className="workspace-home-actions">
          <button
            className={`workspace-filter-btn${showArchived ? ' active' : ''}`}
            onClick={() => setShowArchived(!showArchived)}
          >
            {showArchived ? '显示活跃' : '显示归档'}
          </button>
          <button className="workspace-btn-primary" onClick={() => setShowCreateModal(true)}>
            + 新建工作区
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="workspace-home-empty">加载中...</div>
      ) : displayWorkspaces.length === 0 ? (
        <div className="workspace-home-empty">
          {showArchived ? '没有归档的工作区' : '还没有工作区，点击"新建工作区"开始'}
        </div>
      ) : (
        <div className="workspace-grid">
          {displayWorkspaces.map((task) => (
            <WorkspaceCard
              key={task.id}
              task={task}
              onOpen={openWorkspaceDetail}
              onArchive={handleArchive}
              onDelete={handleDelete}
              onRename={handleRename}
            />
          ))}
        </div>
      )}

      <div className="workspace-home-section">
        <div className="workspace-home-section-header">
          <span className="workspace-home-section-title">连接状态</span>
          <div className="theme-selector">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`theme-btn${currentTheme === t.id ? ' active' : ''}`}
                onClick={() => applyTheme(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="connection-panel">
          {/* Relay server row */}
          <div className="connection-row relay-row">
            <div className="connection-indicator">
              <span
                className="status-dot"
                style={{
                  backgroundColor: relayConnected ? 'var(--success)' : relayConnecting ? 'var(--warning)' : 'var(--text-muted)',
                }}
              />
              <span className="connection-label">
                {relayConnected
                  ? 'Relay 服务器已连接'
                  : relayConnecting
                    ? `正在连接 Relay...${relayStatus?.reconnectAttempt ? ` (重试 ${relayStatus.reconnectAttempt})` : ''}`
                    : '未连接 Relay 服务器'}
              </span>
            </div>
            <div className="connection-actions">
              {relayConnected && mobiles.length === 0 && (
                <button
                  className="workspace-btn-primary"
                  style={{ fontSize: 'var(--font-size-sm)', padding: '4px 12px' }}
                  onClick={() => setShowMobileModal(true)}
                >
                  连接手机
                </button>
              )}
              {!relayConnected && !relayConnecting && (
                <button
                  className="workspace-btn-primary"
                  style={{ fontSize: 'var(--font-size-sm)', padding: '4px 12px' }}
                  onClick={() => setShowMobileModal(true)}
                >
                  连接手机
                </button>
              )}
              {relayConnected && (
                <button className="device-item-disconnect" onClick={handleDisconnectRelay}>
                  断开
                </button>
              )}
            </div>
          </div>

          {/* Mobile devices */}
          {relayConnected && (
            <div className="mobile-devices">
              {mobiles.length > 0 ? (
                mobiles.map((device) => (
                  <div key={device.deviceId} className="connection-row mobile-row">
                    <div className="connection-indicator">
                      <span className="status-dot" style={{ backgroundColor: 'var(--success)' }} />
                      <div className="mobile-device-info">
                        <span className="mobile-device-name">
                          {device.name ?? 'Mobile'}
                        </span>
                        <span className="mobile-device-detail">
                          {[device.platform, device.osVersion, device.appVersion && `v${device.appVersion}`, formatConnectedAt(device.connectedAt)]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="connection-row mobile-row">
                  <div className="connection-indicator">
                    <span className="status-dot" style={{ backgroundColor: 'var(--warning)' }} />
                    <span className="connection-label" style={{ color: 'var(--warning)' }}>
                      等待手机连接...
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showCreateModal && (
        <CreateWorkspaceModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreate}
        />
      )}

      {showMobileModal && (
        <MobileConnectModal onClose={() => setShowMobileModal(false)} />
      )}
    </div>
  )
}
