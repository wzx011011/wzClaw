// ============================================================
// GeneralPanel — 通用设置
//
// 连接配置（Agent URL + Token）+ 测试连接
// ============================================================

import { useState, useCallback } from 'react'
import { useConnectionConfig } from '../../hooks/useConnectionConfig'
import { createDataSource } from '../../data-source'
import { useToastStore } from '../../stores/toast-store'

export default function GeneralPanel(): React.ReactElement {
  const { config, saveConfig, urlError } = useConnectionConfig()
  const toast = useToastStore((s) => s.show)
  const [agentUrl, setAgentUrl] = useState(config.agentUrl)
  const [token, setToken] = useState(config.token)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  const handleSave = useCallback(() => {
    saveConfig({ agentUrl, token })
    toast('连接配置已保存', 'success')
  }, [agentUrl, token, saveConfig, toast])

  const handleTestConnection = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      if (!agentUrl.startsWith('ws://') && !agentUrl.startsWith('wss://')) {
        setTestResult({ success: false, message: 'URL 必须以 ws:// 或 wss:// 开头' })
        return
      }
      const ds = createDataSource(agentUrl, token || undefined)
      await ds.connect()
      ds.disconnect()
      setTestResult({ success: true, message: '连接成功' })
    } catch (err) {
      setTestResult({ success: false, message: `连接失败: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setTesting(false)
    }
  }, [agentUrl, token])

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Agent Server 连接</h3>
      <div className="settings-card">
        <div className="settings-field">
          <label className="settings-label" htmlFor="gs-url">Agent Server 地址</label>
          <input id="gs-url" type="text" className="settings-input" value={agentUrl}
            onChange={(e) => setAgentUrl(e.target.value)} placeholder="wss://agent.5945.top" />
          {urlError && <span className="settings-field-error">{urlError}</span>}
          <span className="settings-field-hint">支持 ws:// 和 wss:// 协议</span>
        </div>
        <div className="settings-field">
          <label className="settings-label" htmlFor="gs-token">认证 Token</label>
          <input id="gs-token" type="password" className="settings-input" value={token}
            onChange={(e) => setToken(e.target.value)} placeholder="可选" />
        </div>
        <div className="settings-field" style={{ flexDirection: 'row', gap: '8px' }}>
          <button className="settings-test-btn" onClick={handleTestConnection} disabled={testing}>
            {testing ? '测试中...' : '测试连接'}
          </button>
          <button className="settings-save-btn" onClick={handleSave}>保存</button>
        </div>
        {testResult && (
          <div style={{
            padding: '8px 12px',
            borderRadius: 'var(--radius-sm)',
            fontSize: 'var(--font-size-sm)',
            color: testResult.success ? 'var(--tool-completed)' : 'var(--tool-error)',
            background: testResult.success ? 'var(--tool-completed-bg)' : 'var(--tool-error-bg)',
          }}>
            {testResult.message}
          </div>
        )}
      </div>
    </div>
  )
}
