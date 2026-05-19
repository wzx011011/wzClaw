// ============================================================
// CreateHostModal — 新建/编辑 Host 弹窗
//
// 提供表单：名称、类型、agentUrl、token（可选）
// 提交后调用 host-store.addHost 或 updateHost
// ============================================================

import React, { useState, useEffect } from 'react'
import type { Host, HostDraft, HostType } from '../../stores/host-store'
import { useHostStore } from '../../stores/host-store'

interface CreateHostModalProps {
  /** 编辑模式时传入现有 host */
  host?: Host
  onClose: () => void
}

const HOST_TYPES: { value: HostType; label: string }[] = [
  { value: 'nas', label: 'NAS' },
  { value: 'server', label: '服务器' },
  { value: 'docker', label: 'Docker' },
  { value: 'custom', label: '自定义' },
]

export default function CreateHostModal({ host, onClose }: CreateHostModalProps): React.ReactElement {
  const { addHost, updateHost } = useHostStore()

  const [name, setName] = useState(host?.name ?? '')
  const [type, setType] = useState<HostType>(host?.type ?? 'custom')
  const [agentUrl, setAgentUrl] = useState(host?.agentUrl ?? '')
  const [token, setToken] = useState(host?.token ?? '')
  const [error, setError] = useState('')

  // 编辑模式下同步 host 数据
  useEffect(() => {
    if (host) {
      setName(host.name)
      setType(host.type)
      setAgentUrl(host.agentUrl)
      setToken(host.token ?? '')
    }
  }, [host])

  const validate = (): boolean => {
    if (!name.trim()) { setError('请输入名称'); return false }
    if (!agentUrl.trim()) { setError('请输入 Agent URL'); return false }
    try { new URL(agentUrl) } catch { setError('Agent URL 格式无效'); return false }
    setError('')
    return true
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return

    const draft: HostDraft = {
      name: name.trim(),
      type,
      agentUrl: agentUrl.trim(),
      token: token.trim() || undefined,
    }

    if (host) {
      updateHost(host.id, draft)
    } else {
      addHost(draft)
    }
    onClose()
  }

  const isEdit = !!host

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        padding: 'var(--sp-4)',
        width: 420,
        maxWidth: '90vw',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-3)',
      }}>
        {/* 标题 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 'var(--font-size-md)', color: 'var(--text-primary)' }}>
            {isEdit ? '编辑 Host' : '新建 Host'}
          </h3>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
              padding: 2,
            }}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
          {/* 名称 */}
          <div className="settings-field">
            <label className="settings-label">名称 *</label>
            <input
              className="settings-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="eg. 我的 NAS"
              autoFocus
            />
          </div>

          {/* 类型 */}
          <div className="settings-field">
            <label className="settings-label">类型</label>
            <select
              className="settings-input"
              value={type}
              onChange={(e) => setType(e.target.value as HostType)}
            >
              {HOST_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {/* Agent URL */}
          <div className="settings-field">
            <label className="settings-label">Agent URL *</label>
            <input
              className="settings-input"
              value={agentUrl}
              onChange={(e) => setAgentUrl(e.target.value)}
              placeholder="http://192.168.1.100:8080"
              type="url"
            />
            <span className="settings-field-hint">agent-server 的 HTTP/WS 地址</span>
          </div>

          {/* Token */}
          <div className="settings-field">
            <label className="settings-label">Token（可选）</label>
            <input
              className="settings-input"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="认证 Token"
              type="password"
            />
          </div>

          {/* 错误 */}
          {error && <span className="settings-field-error">{error}</span>}

          {/* 操作按钮 */}
          <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                padding: '6px 16px',
                fontSize: 13,
              }}
            >
              取消
            </button>
            <button type="submit" className="settings-save-btn">
              {isEdit ? '保存' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
