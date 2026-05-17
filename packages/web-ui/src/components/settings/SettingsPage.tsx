// ============================================================
// SettingsPage — 设置页面
//
// 包含两个分组：
// 1. 连接配置：Agent Server URL + Token + 测试连接按钮
// 2. 外观：主题切换（dark/light）+ 语言切换（中文/英文）
//
// 配置通过 useConnectionConfig hook 保存到 localStorage
// ============================================================

import { useState, useCallback, useEffect } from 'react'
import { useConnectionConfig } from '../../hooks/useConnectionConfig'
import { createDataSource } from '../../data-source'
import { useHandStore, type HandInfo } from '../../stores/hand-store'

interface SettingsPageProps {
  /** 关闭设置页面回调 */
  onClose: () => void
  /** 连接状态变化回调（可选，用于通知 App 组件） */
  onConnectionChange?: (connected: boolean) => void
}

/**
 * SettingsPage — 设置页面
 *
 * 暗色主题 + card 布局 + 表单输入
 * 保存配置到 localStorage
 */
export default function SettingsPage({ onClose, onConnectionChange }: SettingsPageProps): React.ReactElement {
  const { config, saveConfig, urlError } = useConnectionConfig()

  // 表单临时状态（保存前不写入 localStorage）
  const [agentUrl, setAgentUrl] = useState(config.agentUrl)
  const [token, setToken] = useState(config.token)
  const [language, setLanguage] = useState(config.language)
  const [themeMode, setThemeMode] = useState(config.themeMode)

  // 测试连接状态
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  // Hand 列表
  const { hands, loading: handsLoading, fetchHands } = useHandStore()

  useEffect(() => {
    if (config.agentUrl) {
      fetchHands(config.agentUrl)
    }
  }, [config.agentUrl, fetchHands])

  // 保存所有配置
  const handleSave = useCallback(() => {
    saveConfig({ agentUrl, token, language, themeMode })
  }, [agentUrl, token, language, themeMode, saveConfig])

  // 测试连接
  const handleTestConnection = useCallback(async () => {
    setTesting(true)
    setTestResult(null)

    try {
      // 验证 URL 格式
      if (!agentUrl.startsWith('ws://') && !agentUrl.startsWith('wss://')) {
        setTestResult({ success: false, message: 'URL 必须以 ws:// 或 wss:// 开头' })
        setTesting(false)
        return
      }

      const ds = createDataSource(agentUrl, token || undefined)
      await ds.connect()
      ds.disconnect()
      setTestResult({ success: true, message: '连接成功' })
      onConnectionChange?.(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setTestResult({ success: false, message: `连接失败: ${message}` })
      onConnectionChange?.(false)
    } finally {
      setTesting(false)
    }
  }, [agentUrl, token, onConnectionChange])

  return (
    <div className="settings-page">
      {/* 顶部导航 */}
      <div className="settings-header">
        <button className="settings-back-btn" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>返回</span>
        </button>
        <h2 className="settings-title">设置</h2>
      </div>

      <div className="settings-body">
        {/* 连接配置 */}
        <section className="settings-section">
          <h3 className="settings-section-title">连接配置</h3>
          <div className="settings-card">
            <div className="settings-field">
              <label className="settings-label" htmlFor="agent-url">Agent Server 地址</label>
              <input
                id="agent-url"
                type="text"
                className="settings-input"
                value={agentUrl}
                onChange={(e) => setAgentUrl(e.target.value)}
                placeholder="ws://localhost:8082"
              />
              {urlError && <span className="settings-field-error">{urlError}</span>}
              <span className="settings-field-hint">WebSocket 连接地址，支持 ws:// 和 wss:// 协议</span>
            </div>

            <div className="settings-field">
              <label className="settings-label" htmlFor="token">认证 Token</label>
              <input
                id="token"
                type="password"
                className="settings-input"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="可选"
              />
              <span className="settings-field-hint">用于连接认证，留空则不使用认证</span>
            </div>

            {/* 测试连接 */}
            <div className="settings-field">
              <button
                className="settings-test-btn"
                onClick={handleTestConnection}
                disabled={testing}
              >
                {testing ? '测试中...' : '测试连接'}
              </button>
              {testResult && (
                <span className={`settings-test-result ${testResult.success ? 'success' : 'error'}`}>
                  {testResult.message}
                </span>
              )}
            </div>
          </div>
        </section>

        {/* 外观设置 */}
        <section className="settings-section">
          <h3 className="settings-section-title">外观</h3>
          <div className="settings-card">
            <div className="settings-field">
              <label className="settings-label">主题</label>
              <div className="settings-radio-group">
                <label className="settings-radio">
                  <input
                    type="radio"
                    name="theme"
                    value="dark"
                    checked={themeMode === 'dark'}
                    onChange={() => setThemeMode('dark')}
                  />
                  <span>暗色</span>
                </label>
                <label className="settings-radio">
                  <input
                    type="radio"
                    name="theme"
                    value="light"
                    checked={themeMode === 'light'}
                    onChange={() => setThemeMode('light')}
                  />
                  <span>亮色</span>
                </label>
              </div>
            </div>

            <div className="settings-field">
              <label className="settings-label">语言</label>
              <select
                className="settings-select"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="zh-CN">中文</option>
                <option value="en">English</option>
              </select>
            </div>
          </div>
        </section>

        {/* Hand 管理 */}
        <section className="settings-section">
          <h3 className="settings-section-title">Hand 管理</h3>
          <div className="settings-card">
            {handsLoading ? (
              <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
                加载中...
              </span>
            ) : hands.length === 0 ? (
              <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
                暂无在线 Hand。请确保 NAS Hand 或桌面端 Hand 已启动。
              </span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
                {hands.map((hand: HandInfo) => (
                  <div
                    key={hand.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: 'var(--sp-2) var(--sp-3)',
                      background: 'var(--bg-tertiary)',
                      borderRadius: 'var(--radius-md)',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 500 }}>{hand.id}</div>
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                        {hand.type} · {hand.capabilities.length} 工具 · 优先级 {hand.priority}
                      </div>
                    </div>
                    <span style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: '#4caf50',
                      display: 'inline-block',
                    }} />
                  </div>
                ))}
              </div>
            )}
            <div className="settings-field" style={{ marginTop: 'var(--sp-2)' }}>
              <button
                className="settings-test-btn"
                onClick={() => fetchHands(config.agentUrl)}
              >
                刷新列表
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* 底部保存按钮 */}
      <div className="settings-footer">
        <button className="settings-save-btn" onClick={handleSave}>
          保存设置
        </button>
      </div>
    </div>
  )
}
