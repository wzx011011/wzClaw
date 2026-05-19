// ============================================================
// HandPanel — Hand 管理面板
//
// 展示已注册的 Hand 实例（来自 hand-store）
// ============================================================

import { useEffect, useCallback } from 'react'
import { useHandStore, type HandInfo } from '../../stores/hand-store'
import { useConnectionConfig } from '../../hooks/useConnectionConfig'

export default function HandPanel(): React.ReactElement {
  const { config } = useConnectionConfig()
  const { hands, loading, fetchHands } = useHandStore()

  useEffect(() => {
    if (config.agentUrl) {
      fetchHands(config.agentUrl, config.token || undefined)
    }
  }, [config.agentUrl, config.token, fetchHands])

  const handleRefresh = useCallback(() => {
    fetchHands(config.agentUrl, config.token || undefined)
  }, [config.agentUrl, config.token, fetchHands])

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Hand 管理</h3>
      <div className="settings-card">
        <div className="settings-field">
          <span className="settings-field-hint">
            Hand 是连接到 Agent Server 的工具执行器。桌面端 Hand 提供文件系统、终端等工具。
          </span>
        </div>

        {loading && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', padding: '8px 0' }}>
            加载中...
          </div>
        )}

        {!loading && hands.length === 0 && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', padding: '16px 0', textAlign: 'center' }}>
            暂无在线 Hand<br />
            <span style={{ fontSize: '11px', marginTop: '4px', display: 'block', color: 'var(--text-muted)' }}>
              请确保 NAS Hand 或桌面端 Hand 已启动
            </span>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {hands.map((hand: HandInfo) => (
            <div key={hand.id} style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 12px',
              background: 'var(--bg-primary)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
            }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
                    {hand.id}
                  </span>
                  <span style={{
                    fontSize: '10px',
                    padding: '1px 5px',
                    borderRadius: '9999px',
                    background: 'var(--accent)20',
                    color: 'var(--accent)',
                  }}>
                    {hand.type}
                  </span>
                  {hand.priority > 0 && (
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                      优先级 {hand.priority}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
                  {hand.capabilities.length} 个工具
                  {hand.capabilities.length > 0 && (
                    <span style={{ marginLeft: '6px' }}>
                      {hand.capabilities.slice(0, 4).join(', ')}
                      {hand.capabilities.length > 4 ? ` 等` : ''}
                    </span>
                  )}
                </div>
              </div>
              <div style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--status-connected)',
                flexShrink: 0,
              }} />
            </div>
          ))}
        </div>

        <div className="settings-field" style={{ marginTop: '12px' }}>
          <button className="settings-test-btn" onClick={handleRefresh} disabled={loading}>
            {loading ? '加载中...' : '刷新列表'}
          </button>
        </div>
      </div>
    </div>
  )
}
