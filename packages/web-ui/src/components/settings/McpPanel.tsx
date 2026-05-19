// ============================================================
// McpPanel — MCP 服务器配置
//
// 显示已配置的 MCP 服务器及其工具列表
// ============================================================

import { useState, useEffect, useCallback } from 'react'
import { useDataSource } from '../../providers/DataSourceProvider'
import { useToastStore } from '../../stores/toast-store'

interface McpTool {
  name: string
  description: string
  serverName?: string
}

interface McpServer {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  enabled: boolean
  toolCount?: number
}

export default function McpPanel(): React.ReactElement {
  const ds = useDataSource()
  const toast = useToastStore((s) => s.show)
  const [tools, setTools] = useState<McpTool[]>([])
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'tools' | 'servers'>('tools')

  useEffect(() => {
    if (!ds?.isConnected()) return
    setLoading(true)
    Promise.all([
      ds.listMcpTools?.().catch(() => [] as McpTool[]),
      (ds as any).listMcpServers?.().catch(() => [] as McpServer[]),
    ]).then(([t, s]) => {
      setTools(t ?? [])
      setServers(s ?? [])
      setLoading(false)
    })
  }, [ds])

  const handleRefresh = useCallback(async () => {
    if (!ds?.isConnected()) return
    setLoading(true)
    try {
      const [t, s] = await Promise.all([
        ds.listMcpTools?.().catch(() => [] as McpTool[]),
        (ds as any).listMcpServers?.().catch(() => [] as McpServer[]),
      ])
      setTools(t ?? [])
      setServers(s ?? [])
      toast('MCP 工具列表已刷新', 'success')
    } finally {
      setLoading(false)
    }
  }, [ds, toast])

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">MCP 服务器</h3>
      <div className="settings-card">
        {/* Tab 切换 */}
        <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
          {(['tools', 'servers'] as const).map((t) => (
            <button key={t} onClick={() => setActiveTab(t)} style={{
              padding: '5px 14px',
              borderRadius: 'var(--radius-sm)',
              border: `1px solid ${activeTab === t ? 'var(--accent)' : 'var(--border)'}`,
              background: activeTab === t ? 'var(--accent)' : 'transparent',
              color: activeTab === t ? '#fff' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 'var(--font-size-sm)',
            }}>
              {t === 'tools' ? `工具 (${tools.length})` : `服务器 (${servers.length})`}
            </button>
          ))}
          <button
            onClick={handleRefresh}
            disabled={loading}
            style={{
              marginLeft: 'auto',
              padding: '5px 10px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 'var(--font-size-sm)',
            }}
          >
            {loading ? '加载中...' : '刷新'}
          </button>
        </div>

        {/* 工具列表 */}
        {activeTab === 'tools' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '400px', overflow: 'auto' }}>
            {tools.length === 0 && !loading && (
              <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', padding: '20px 0', textAlign: 'center' }}>
                {ds?.isConnected() ? '暂无 MCP 工具（未配置服务器或服务器未连接）' : '需要连接 Agent Server 才能查看 MCP 工具'}
              </div>
            )}
            {tools.map((tool) => (
              <div key={tool.name} style={{
                padding: '8px 12px',
                background: 'var(--bg-primary)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <code style={{ fontSize: '11px', color: 'var(--accent)', fontWeight: 600 }}>
                    mcp_{tool.serverName ? `${tool.serverName}_` : ''}{tool.name}
                  </code>
                </div>
                {tool.description && (
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '3px', lineHeight: 1.4 }}>
                    {tool.description}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 服务器列表 */}
        {activeTab === 'servers' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {servers.length === 0 && !loading && (
              <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', padding: '20px 0', textAlign: 'center' }}>
                未配置 MCP 服务器<br />
                <span style={{ fontSize: '11px', marginTop: '4px', display: 'block' }}>
                  在 NAS 上的 ~/.wzxclaw/mcp.json 中配置
                </span>
              </div>
            )}
            {servers.map((s) => (
              <div key={s.name} style={{
                padding: '10px 12px',
                background: 'var(--bg-primary)',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${s.enabled ? 'var(--tool-completed)20' : 'var(--border)'}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)', fontWeight: 500 }}>
                    {s.name}
                  </span>
                  <span style={{
                    fontSize: '10px',
                    padding: '1px 6px',
                    borderRadius: '9999px',
                    background: s.enabled ? 'var(--tool-completed)20' : 'var(--border)',
                    color: s.enabled ? 'var(--tool-completed)' : 'var(--text-muted)',
                  }}>
                    {s.enabled ? '启用' : '禁用'}
                  </span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px', fontFamily: 'monospace' }}>
                  {s.command} {s.args?.join(' ')}
                </div>
                {s.toolCount !== undefined && (
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    {s.toolCount} 个工具
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
