// ============================================================
// ToolsPanel — 工具列表面板
//
// 展示当前已连接 Hand 提供的所有工具
// ============================================================

import { useState, useEffect } from 'react'
import { useDataSource } from '../../providers/DataSourceProvider'

interface ToolInfo {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
  handId?: string
  handName?: string
  source?: 'hand' | 'builtin' | 'mcp'
}

const SOURCE_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  hand: { bg: 'var(--accent)20', text: 'var(--accent)', label: 'Hand' },
  builtin: { bg: 'var(--tool-completed)20', text: 'var(--tool-completed)', label: '内置' },
  mcp: { bg: 'var(--warning)20', text: 'var(--warning)', label: 'MCP' },
}

export default function ToolsPanel(): React.ReactElement {
  const ds = useDataSource()
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!ds?.isConnected()) return
    setLoading(true)
    ;(ds as any).listTools?.().then((list: ToolInfo[]) => {
      setTools(list ?? [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [ds])

  const filtered = filter.trim()
    ? tools.filter((t) =>
        t.name.toLowerCase().includes(filter.toLowerCase()) ||
        t.description?.toLowerCase().includes(filter.toLowerCase())
      )
    : tools

  const byHand = filtered.reduce<Record<string, ToolInfo[]>>((acc, tool) => {
    const key = tool.handName ?? tool.handId ?? '默认'
    if (!acc[key]) acc[key] = []
    acc[key].push(tool)
    return acc
  }, {})

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">可用工具</h3>
      <div className="settings-card">
        {/* 搜索框 */}
        <div className="settings-field">
          <input
            type="text"
            className="settings-input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索工具名称..."
          />
        </div>

        {loading && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', padding: '12px 0' }}>
            加载工具列表...
          </div>
        )}
        {!loading && !ds?.isConnected() && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', padding: '20px 0', textAlign: 'center' }}>
            需要连接 Agent Server 才能查看工具
          </div>
        )}
        {!loading && ds?.isConnected() && filtered.length === 0 && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', padding: '20px 0', textAlign: 'center' }}>
            {filter ? `无匹配工具 "${filter}"` : '暂无工具（未有 Hand 注册）'}
          </div>
        )}

        {!loading && Object.entries(byHand).map(([handName, handTools]) => (
          <div key={handName} style={{ marginBottom: '16px' }}>
            <div style={{
              fontSize: '10px',
              fontWeight: 600,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: '6px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}>
              <span>Hand: {handName}</span>
              <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({handTools.length} 个)</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {handTools.map((tool) => {
                const sourceStyle = SOURCE_COLORS[tool.source ?? 'hand']
                return (
                  <div key={tool.name} style={{
                    padding: '8px 12px',
                    background: 'var(--bg-primary)',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <code style={{ fontSize: '12px', color: 'var(--accent)', fontWeight: 600 }}>
                        {tool.name}
                      </code>
                      {sourceStyle && (
                        <span style={{
                          fontSize: '9px',
                          padding: '1px 5px',
                          borderRadius: '9999px',
                          background: sourceStyle.bg,
                          color: sourceStyle.text,
                        }}>
                          {sourceStyle.label}
                        </span>
                      )}
                    </div>
                    {tool.description && (
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '3px', lineHeight: 1.4 }}>
                        {tool.description}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
