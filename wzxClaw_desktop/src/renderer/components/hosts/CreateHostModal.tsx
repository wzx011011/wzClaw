import React, { useState } from 'react'
import { useHostStore } from '../../stores/host-store'
import type { Host } from '../../../shared/types'

interface CreateHostModalProps {
  onClose: () => void
  onCreated: (host: Host) => void
}

export default function CreateHostModal({ onClose, onCreated }: CreateHostModalProps): JSX.Element {
  const createHost = useHostStore((s) => s.createHost)
  const testConnection = useHostStore((s) => s.testConnection)

  const [name, setName] = useState('')
  const [hostAddr, setHostAddr] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('root')
  const [authType, setAuthType] = useState<'password' | 'key'>('password')
  const [password, setPassword] = useState('')
  const [description, setDescription] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)
  const [creating, setCreating] = useState(false)

  const handleTest = async () => {
    if (!hostAddr) return
    setTesting(true)
    setTestResult(null)
    // 先创建临时主机用于测试
    try {
      const host = await createHost({ name: name || hostAddr, host: hostAddr, port: parseInt(port) || 22, username, authType, password, description })
      const result = await testConnection(host.id)
      setTestResult(result)
      if (!result.success) {
        // 测试失败则删除临时主机
        await useHostStore.getState().deleteHost(host.id)
      }
    } catch (err) {
      setTestResult({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
    setTesting(false)
  }

  const handleCreate = async () => {
    if (!hostAddr || !username) return
    setCreating(true)
    try {
      const host = await createHost({ name: name || hostAddr, host: hostAddr, port: parseInt(port) || 22, username, authType, password, description })
      onCreated(host)
    } catch (err) {
      console.error('Create host failed:', err)
    }
    setCreating(false)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">添加主机</h2>

        <div className="modal-field">
          <label>名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：群晖 NAS" />
        </div>

        <div className="modal-field-row">
          <div className="modal-field" style={{ flex: 2 }}>
            <label>主机地址</label>
            <input value={hostAddr} onChange={(e) => setHostAddr(e.target.value)} placeholder="IP 或域名" />
          </div>
          <div className="modal-field" style={{ flex: 1 }}>
            <label>端口</label>
            <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" />
          </div>
        </div>

        <div className="modal-field">
          <label>用户名</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
        </div>

        <div className="modal-field">
          <label>认证方式</label>
          <div className="modal-radio-group">
            <label><input type="radio" checked={authType === 'password'} onChange={() => setAuthType('password')} /> 密码</label>
            <label><input type="radio" checked={authType === 'key'} onChange={() => setAuthType('key')} /> 私钥</label>
          </div>
        </div>

        {authType === 'password' ? (
          <div className="modal-field">
            <label>密码</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="SSH 密码" />
          </div>
        ) : (
          <div className="modal-field">
            <label>私钥路径</label>
            <input placeholder="~/.ssh/id_rsa" />
          </div>
        )}

        <div className="modal-field">
          <label>描述（可选）</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="备注信息" />
        </div>

        {testResult && (
          <div className={`modal-test-result ${testResult.success ? 'success' : 'error'}`}>
            {testResult.success ? '连接成功' : `连接失败: ${testResult.error}`}
          </div>
        )}

        <div className="modal-actions">
          <button className="workspace-btn-secondary" onClick={onClose}>取消</button>
          <button className="workspace-btn-secondary" onClick={handleTest} disabled={testing || !hostAddr}>
            {testing ? '测试中...' : '测试连接'}
          </button>
          <button className="workspace-btn-primary" onClick={handleCreate} disabled={creating || !hostAddr}>
            {creating ? '创建中...' : '添加'}
          </button>
        </div>
      </div>
    </div>
  )
}
