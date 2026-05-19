// ============================================================
// PluginPanel — 插件管理面板
//
// 列出可用插件（Hand 工具集），支持启用/禁用
// ============================================================

import { useState, useEffect, useCallback } from 'react'
import { useDataSource } from '../../providers/DataSourceProvider'
import { useToastStore } from '../../stores/toast-store'

interface PluginEntry {
  id: string
  name: string
  description?: string
  enabled: boolean
  version?: string
  author?: string
  type?: 'builtin' | 'external'
}

export default function PluginPanel(): React.ReactElement {
  const ds = useDataSource()
  const toast = useToastStore((s) => s.show)
  const [plugins, setPlugins] = useState<PluginEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)

  const loadPlugins = useCallback(async () => {
    if (!ds?.isConnected()) return
    setLoading(true)
    try {
      const list = await ds.listPlugins?.() ?? []
      setPlugins(list as PluginEntry[])
    } finally {
      setLoading(false)
    }
  }, [ds])

  useEffect(() => { loadPlugins() }, [loadPlugins])

  const handleToggle = useCallback(async (id: string, currentEnabled: boolean) => {
    setToggling(id)
    try {
      if (currentEnabled) {
        await (ds as any).disablePlugin?.(id)
      } else {
        await (ds as any).enablePlugin?.(id)
      }
      setPlugins((prev) => prev.map((p) => p.id === id ? { ...p, enabled: !p.enabled } : p))
      toast(`插件已${currentEnabled ? '禁用' : '启用'}`, 'success')
    } catch (err) {
      toast(`操作失败: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setToggling(null)
    }
  }, [ds, toast])

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">插件管理</h3>
      <div className="settings-card">
        {loading && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', padding: '12px 0' }}>
            加载插件列表...
          </div>
        )}
        {!loading && !ds?.isConnected() && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', padding: '20px 0', textAlign: 'center' }}>
            需要连接 Agent Server 才能管理插件
          </div>
        )}
        {!loading && ds?.isConnected() && plugins.length === 0 && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', padding: '20px 0', textAlign: 'center' }}>
            暂无插件
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {plugins.map((plugin) => (
            <div key={plugin.id} style={{
              display: 'flex',
              alignItems: 'flex-start',
              padding: '10px 12px',
              background: 'var(--bg-primary)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              gap: '12px',
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)', fontWeight: 500 }}>
                    {plugin.name}
                  </span>
                  {plugin.version && (
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>v{plugin.version}</span>
                  )}
                  {plugin.type === 'builtin' && (
                    <span style={{
                      fontSize: '10px',
                      padding: '1px 5px',
                      borderRadius: '9999px',
                      background: 'var(--accent)20',
                      color: 'var(--accent)',
                    }}>内置</span>
                  )}
                </div>
                {plugin.description && (
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '3px', lineHeight: 1.4 }}>
                    {plugin.description}
                  </div>
                )}
                {plugin.author && (
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    作者: {plugin.author}
                  </div>
                )}
              </div>
              <button
                onClick={() => handleToggle(plugin.id, plugin.enabled)}
                disabled={toggling === plugin.id}
                style={{
                  padding: '4px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: `1px solid ${plugin.enabled ? 'var(--tool-error)' : 'var(--tool-completed)'}`,
                  background: 'transparent',
                  color: plugin.enabled ? 'var(--tool-error)' : 'var(--tool-completed)',
                  cursor: 'pointer',
                  fontSize: '11px',
                  whiteSpace: 'nowrap',
                  opacity: toggling === plugin.id ? 0.6 : 1,
                }}
              >
                {toggling === plugin.id ? '...' : plugin.enabled ? '禁用' : '启用'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
