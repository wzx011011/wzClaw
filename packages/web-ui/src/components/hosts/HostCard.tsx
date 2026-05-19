// ============================================================
// HostCard — 单个 Host 配置卡片
//
// 显示 Host 信息、在线状态，提供连接测试、设为默认、删除操作。
// ============================================================

import React from 'react'
import type { Host } from '../../stores/host-store'
import { useHostStore } from '../../stores/host-store'

interface HostCardProps {
  host: Host
  onEdit?: (host: Host) => void
}

const STATUS_COLOR: Record<string, string> = {
  online: 'var(--status-connected, #22c55e)',
  offline: 'var(--status-disconnected, #ef4444)',
  error: 'var(--tool-error, #ef4444)',
  unknown: 'var(--text-muted, #666)',
}

const STATUS_LABEL: Record<string, string> = {
  online: '在线',
  offline: '离线',
  error: '错误',
  unknown: '未知',
}

export default function HostCard({ host, onEdit }: HostCardProps): React.ReactElement {
  const { removeHost, setDefault, setStatus } = useHostStore()

  const handleTestConnect = async () => {
    setStatus(host.id, 'unknown', undefined)
    try {
      const ws = new WebSocket(host.agentUrl.replace(/^http/, 'ws'))
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { ws.close(); reject(new Error('超时')) }, 5000)
        ws.onopen = () => { clearTimeout(timer); ws.close(); resolve() }
        ws.onerror = () => { clearTimeout(timer); reject(new Error('连接失败')) }
      })
      setStatus(host.id, 'online', undefined)
    } catch (err) {
      setStatus(host.id, 'offline', err instanceof Error ? err.message : '连接失败')
    }
  }

  const handleRemove = () => {
    if (window.confirm(`确认删除 Host「${host.name}」？`)) {
      removeHost(host.id)
    }
  }

  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: `1px solid ${host.isDefault ? 'var(--accent)' : 'var(--border)'}`,
      borderRadius: 'var(--radius-sm)',
      padding: 'var(--sp-3)',
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--sp-2)',
      position: 'relative',
    }}>
      {/* 标题行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
        {/* 状态点 */}
        <span style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: STATUS_COLOR[host.status] ?? STATUS_COLOR.unknown,
          flexShrink: 0,
        }} />
        <span style={{ fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
          {host.name}
        </span>
        {host.isDefault && (
          <span style={{
            fontSize: 10,
            padding: '1px 6px',
            background: 'var(--accent)',
            color: '#fff',
            borderRadius: 10,
          }}>
            默认
          </span>
        )}
        <span style={{ fontSize: 11, color: STATUS_COLOR[host.status] ?? STATUS_COLOR.unknown }}>
          {STATUS_LABEL[host.status] ?? '未知'}
        </span>
      </div>

      {/* 地址 */}
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
        {host.agentUrl}
      </div>

      {/* 类型 + 创建时间 */}
      <div style={{ display: 'flex', gap: '12px', fontSize: 11, color: 'var(--text-muted)' }}>
        <span>类型: {host.type}</span>
        <span>创建: {new Date(host.createdAt).toLocaleDateString()}</span>
        {host.lastConnectedAt && (
          <span>最近: {new Date(host.lastConnectedAt).toLocaleDateString()}</span>
        )}
      </div>

      {/* 操作按钮 */}
      <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-2)', flexWrap: 'wrap' }}>
        <button
          onClick={handleTestConnect}
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
          测试连接
        </button>
        {!host.isDefault && (
          <button
            onClick={() => setDefault(host.id)}
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
            设为默认
          </button>
        )}
        {onEdit && (
          <button
            onClick={() => onEdit(host)}
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
            编辑
          </button>
        )}
        <button
          onClick={handleRemove}
          style={{
            background: 'transparent',
            border: '1px solid var(--tool-error, #ef4444)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--tool-error, #ef4444)',
            cursor: 'pointer',
            fontSize: 12,
            padding: '3px 10px',
            marginLeft: 'auto',
          }}
        >
          删除
        </button>
      </div>
    </div>
  )
}
