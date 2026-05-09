import React, { useState } from 'react'
import type { Host } from '../../../shared/types'

interface HostCardProps {
  host: Host
  onOpen: (hostId: string) => void
  onTestConnection: (hostId: string) => Promise<{ success: boolean; error?: string }>
  onDelete: (hostId: string) => void
}

export default function HostCard({ host, onOpen, onTestConnection, onDelete }: HostCardProps): JSX.Element {
  const [testing, setTesting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const statusColor = host.status === 'online'
    ? 'var(--success)'
    : host.status === 'offline'
      ? 'var(--error)'
      : 'var(--text-muted)'

  const handleTest = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setTesting(true)
    await onTestConnection(host.id)
    setTesting(false)
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirmDelete) {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 5000)
      return
    }
    onDelete(host.id)
  }

  return (
    <div className="workspace-card" onClick={() => onOpen(host.id)}>
      <div className="workspace-card-header">
        <div className="workspace-card-title-row">
          <span className="status-dot" style={{ backgroundColor: statusColor, flexShrink: 0 }} />
          <h3 className="workspace-card-title">{host.name}</h3>
        </div>
        <div className="workspace-card-actions">
          <button
            className="workspace-card-btn"
            title="测试连接"
            onClick={handleTest}
            disabled={testing}
          >
            {testing ? '⟳' : '⚡'}
          </button>
          <button
            className={`workspace-card-btn${confirmDelete ? ' workspace-card-btn-danger' : ''}`}
            title={confirmDelete ? '确认删除' : '删除'}
            onClick={handleDelete}
          >
            {confirmDelete ? '✓' : '✕'}
          </button>
        </div>
      </div>
      <div className="workspace-card-meta">
        <span>{host.username}@{host.host}:{host.port}</span>
        {host.lastConnectedAt ? (
          <span> · {new Date(host.lastConnectedAt).toLocaleDateString()}</span>
        ) : null}
      </div>
      {host.description && (
        <p className="workspace-card-description">{host.description}</p>
      )}
      {host.tags && host.tags.length > 0 && (
        <div className="workspace-card-tags">
          {host.tags.map(tag => (
            <span key={tag} className="workspace-card-tag">{tag}</span>
          ))}
        </div>
      )}
    </div>
  )
}
