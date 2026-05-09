import React, { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useHostStore } from '../../stores/host-store'
import { useT } from '../../i18n/useT'
import WorkspaceCard from './WorkspaceCard'
import CreateWorkspaceModal from './CreateTaskModal'
import MobileConnectModal from '../ide/MobileConnectModal'
import HostCard from '../hosts/HostCard'
import CreateHostModal from '../hosts/CreateHostModal'

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
  const t = useT()
  const tasks = useWorkspaceStore((s) => s.tasks)
  const isLoading = useWorkspaceStore((s) => s.isLoading)
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces)
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace)
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace)
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace)
  const openWorkspaceDetail = useWorkspaceStore((s) => s.openWorkspaceDetail)
  const addProject = useWorkspaceStore((s) => s.addProject)

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null)
  const [showMobileModal, setShowMobileModal] = useState(false)
  const [activeTab, setActiveTab] = useState<'workspaces' | 'hosts'>('workspaces')
  const [showCreateHostModal, setShowCreateHostModal] = useState(false)

  // Host store
  const hosts = useHostStore((s) => s.hosts)
  const loadHosts = useHostStore((s) => s.loadHosts)
  const updateHost = useHostStore((s) => s.updateHost)
  const deleteHost = useHostStore((s) => s.deleteHost)
  const openHostDetail = useHostStore((s) => s.openHostDetail)
  const testConnection = useHostStore((s) => s.testConnection)

  useEffect(() => {
    loadWorkspaces()
  }, [loadWorkspaces])

  useEffect(() => {
    if (activeTab === 'hosts') loadHosts()
  }, [activeTab, loadHosts])

  useEffect(() => {
    window.wzxclaw.getRelayStatus().then(setRelayStatus)
    const unsubRelay = window.wzxclaw.onRelayStatus(setRelayStatus)
    return () => { unsubRelay() }
  }, [])

  const activeWorkspaces = tasks.filter((t) => !t.archived)
  const archivedWorkspaces = tasks.filter((t) => t.archived)
  const displayWorkspaces = showArchived ? archivedWorkspaces : activeWorkspaces

  const handleCreate = async (title: string, description?: string, folderPath?: string) => {
    try {
      const workspace = await createWorkspace(title, description)
      // 如果用户选择了文件夹，自动绑定为工作区项目
      if (folderPath && workspace.id) {
        await addProject(workspace.id, folderPath)
      }
      setShowCreateModal(false)
      openWorkspaceDetail(workspace.id)
    } catch (err) {
      console.error('[WorkspaceHomePage] Failed to create workspace:', err)
      // modal 保持打开，允许用户重试
    }
  }

  const handleArchive = (workspaceId: string) => {
    const workspace = tasks.find((t) => t.id === workspaceId)
    if (workspace) {
      updateWorkspace(workspaceId, { archived: !workspace.archived })
    }
  }

  const handleDelete = (workspaceId: string) => {
    // 删除确认现在在 WorkspaceCard 内联完成，避免原生 confirm() 突兀的体验
    deleteWorkspace(workspaceId)
  }

  const handleRename = (workspaceId: string, newTitle: string) => {
    updateWorkspace(workspaceId, { title: newTitle })
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
      <div className="workspace-home-dragbar">
      </div>
      <div className="workspace-home-header">
        <h1 className="workspace-home-title">{t('workspace.title')}</h1>
        <div className="workspace-home-actions">
          {/* Tab 切换 */}
          <div className="workspace-tab-bar">
            <button
              className={`workspace-tab${activeTab === 'workspaces' ? ' active' : ''}`}
              onClick={() => setActiveTab('workspaces')}
            >
              工作区
            </button>
            <button
              className={`workspace-tab${activeTab === 'hosts' ? ' active' : ''}`}
              onClick={() => setActiveTab('hosts')}
            >
              主机
            </button>
          </div>
          {activeTab === 'workspaces' && (
            <>
              <button
                className={`workspace-filter-btn${showArchived ? ' active' : ''}`}
                onClick={() => setShowArchived(!showArchived)}
              >
                {showArchived ? t('workspace.showActive') : t('workspace.showArchived')}
              </button>
              <button className="workspace-btn-primary" onClick={() => setShowCreateModal(true)}>
                {t('workspace.newWorkspace')}
              </button>
            </>
          )}
          {activeTab === 'hosts' && (
            <button className="workspace-btn-primary" onClick={() => setShowCreateHostModal(true)}>
              + 添加主机
            </button>
          )}
        </div>
      </div>

      {activeTab === 'workspaces' ? (
        isLoading ? (
          <div className="workspace-home-empty">加载中...</div>
        ) : displayWorkspaces.length === 0 ? (
          <div className="workspace-home-empty">
            {showArchived ? t('workspace.noArchived') : t('workspace.empty')}
          </div>
        ) : (
          <div className="workspace-grid">
            {displayWorkspaces.map((workspace) => (
              <WorkspaceCard
                key={workspace.id}
                workspace={workspace}
                onOpen={openWorkspaceDetail}
                onArchive={handleArchive}
                onDelete={handleDelete}
                onRename={handleRename}
              />
            ))}
          </div>
        )
      ) : (
        // ── 主机列表 ──
        hosts.length === 0 ? (
          <div className="workspace-home-empty">
            暂无主机，点击上方"添加主机"连接你的 NAS 或服务器
          </div>
        ) : (
          <div className="workspace-grid">
            {hosts.map((host) => (
              <HostCard
                key={host.id}
                host={host}
                onOpen={openHostDetail}
                onTestConnection={testConnection}
                onDelete={deleteHost}
              />
            ))}
          </div>
        )
      )}

      <div className="workspace-home-section">
        <div className="workspace-home-section-header">
          <span className="workspace-home-section-title">{t('workspace.connectionStatus')}</span>
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
                  ? t('workspace.relayConnected')
                  : relayConnecting
                    ? `${t('workspace.relayConnecting')}${relayStatus?.reconnectAttempt ? ` (${relayStatus.reconnectAttempt})` : ''}`
                    : t('workspace.relayDisconnected')}
              </span>
            </div>
            <div className="connection-actions">
              {relayConnected && mobiles.length === 0 && (
                <button
                  className="workspace-btn-primary"
                  style={{ fontSize: 'var(--font-size-sm)', padding: '4px 12px' }}
                  onClick={() => setShowMobileModal(true)}
                >
                  {t('workspace.connectPhone')}
                </button>
              )}
              {!relayConnected && !relayConnecting && (
                <button
                  className="workspace-btn-primary"
                  style={{ fontSize: 'var(--font-size-sm)', padding: '4px 12px' }}
                  onClick={() => setShowMobileModal(true)}
                >
                  {t('workspace.connectPhone')}
                </button>
              )}
              {relayConnected && (
                <button className="device-item-disconnect" onClick={handleDisconnectRelay}>
                  {t('workspace.disconnect')}
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
                      {t('workspace.waitingForMobile')}
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

      {showCreateHostModal && (
        <CreateHostModal
          onClose={() => setShowCreateHostModal(false)}
          onCreated={(host) => {
            setShowCreateHostModal(false)
            openHostDetail(host.id)
          }}
        />
      )}
    </div>
  )
}
