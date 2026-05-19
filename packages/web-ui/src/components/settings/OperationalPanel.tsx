// ============================================================
// OperationalPanel — 运维功能面板
//
// Tab 切换展示：Hosts / Plugins / Indexing / Insights
// 所有功能由 RuntimeCapabilities 驱动，不可用时隐藏
// ============================================================

import { useState, useEffect, useCallback } from 'react'
import { useDataSource } from '../../providers/DataSourceProvider'

interface HostEntry {
  id: string; name: string; address: string; port: number
  username: string; authType: string; description?: string
  archived?: boolean; createdAt: number; updatedAt: number
}

interface PluginEntry {
  id: string; name: string; description?: string
  enabled: boolean; version?: string
}

type Tab = 'hosts' | 'plugins' | 'indexing' | 'insights'

export default function OperationalPanel(): React.ReactElement | null {
  const ds = useDataSource()
  const [tab, setTab] = useState<Tab>('hosts')
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({})

  // Hosts
  const [hosts, setHosts] = useState<HostEntry[]>([])
  const [hostLoading, setHostLoading] = useState(false)
  const [showAddHost, setShowAddHost] = useState(false)

  // Plugins
  const [plugins, setPlugins] = useState<PluginEntry[]>([])
  const [pluginLoading, setPluginLoading] = useState(false)

  // Indexing
  const [indexingStatus, setIndexingStatus] = useState<{
    available: boolean; backend: string; indexedFiles: number; lastIndexed: number | null
  } | null>(null)

  // Insights
  const [insightsStatus, setInsightsStatus] = useState<{
    available: boolean; reportExists: boolean; lastGenerated: number | null
  } | null>(null)

  useEffect(() => {
    if (!ds?.isConnected()) return
    ds.getCapabilities?.().then(caps => {
      setCapabilities({
        hosts: caps.hosts,
        plugins: caps.plugins,
        indexing: caps.indexing,
        insights: caps.insights,
      })
    }).catch(() => {})
  }, [ds])

  // 加载当前 tab 数据
  useEffect(() => {
    if (!ds?.isConnected()) return
    if (tab === 'hosts' && capabilities.hosts) {
      setHostLoading(true)
      ds.listHosts?.().then(h => { setHosts(h ?? []); setHostLoading(false) }).catch(() => setHostLoading(false))
    }
    if (tab === 'plugins' && capabilities.plugins) {
      setPluginLoading(true)
      ds.listPlugins?.().then(p => { setPlugins(p ?? []); setPluginLoading(false) }).catch(() => setPluginLoading(false))
    }
    if (tab === 'indexing' && capabilities.indexing) {
      ds.getIndexingStatus?.().then(s => setIndexingStatus(s)).catch(() => {})
    }
    if (tab === 'insights' && capabilities.insights) {
      ds.getInsightsStatus?.().then(s => setInsightsStatus(s)).catch(() => {})
    }
  }, [tab, ds, capabilities])

  const handleDeleteHost = useCallback(async (id: string) => {
    if (!confirm('确认删除此主机？')) return
    await ds?.deleteHost?.(id)
    setHosts(prev => prev.filter(h => h.id !== id))
  }, [ds])

  // 过滤可用的 tabs
  const availableTabs: Array<{ key: Tab; label: string }> = [
    capabilities.hosts && { key: 'hosts' as Tab, label: 'Hosts' },
    capabilities.plugins && { key: 'plugins' as Tab, label: 'Plugins' },
    capabilities.indexing && { key: 'indexing' as Tab, label: 'Indexing' },
    capabilities.insights && { key: 'insights' as Tab, label: 'Insights' },
  ].filter(Boolean) as Array<{ key: Tab; label: string }>

  if (availableTabs.length === 0) return null

  // 如果当前 tab 不可用，切到第一个可用的
  const activeTab = availableTabs.some(t => t.key === tab) ? tab : availableTabs[0]?.key

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
      {/* Tab 切换 */}
      <div style={{ display: 'flex', gap: 'var(--sp-2)', borderBottom: '1px solid var(--border-primary)', paddingBottom: 'var(--sp-2)' }}>
        {availableTabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: 'var(--sp-1) var(--sp-3)',
              background: activeTab === t.key ? 'var(--bg-active)' : 'transparent',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              color: activeTab === t.key ? 'var(--text-primary)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 'var(--font-size-sm)',
              fontWeight: activeTab === t.key ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Hosts Tab */}
      {activeTab === 'hosts' && (
        <div>
          {hostLoading ? (
            <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>加载中...</span>
          ) : hosts.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
              暂无主机。点击下方按钮添加。
            </div>
          ) : (
            hosts.map(host => (
              <div key={host.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: 'var(--sp-2) var(--sp-3)',
                background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-md)',
                marginBottom: 'var(--sp-1)',
              }}>
                <div>
                  <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 500 }}>{host.name}</div>
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                    {host.username}@{host.address}:{host.port} · {host.authType}
                  </div>
                </div>
                <button onClick={() => handleDeleteHost(host.id)} style={{
                  background: 'transparent', border: 'none', color: 'var(--text-muted)',
                  cursor: 'pointer', fontSize: 'var(--font-size-sm)',
                }}>
                  删除
                </button>
              </div>
            ))
          )}
          {showAddHost ? (
            <AddHostForm
              onSave={async (input) => {
                const host = await ds?.createHost?.(input)
                if (host) setHosts(prev => [...prev, host])
                setShowAddHost(false)
              }}
              onCancel={() => setShowAddHost(false)}
            />
          ) : (
            <button
              onClick={() => setShowAddHost(true)}
              style={{
                marginTop: 'var(--sp-2)',
                padding: 'var(--sp-1) var(--sp-3)',
                background: 'var(--bg-active)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                fontSize: 'var(--font-size-sm)',
              }}
            >
              + 添加主机
            </button>
          )}
        </div>
      )}

      {/* Plugins Tab */}
      {activeTab === 'plugins' && (
        <div>
          {pluginLoading ? (
            <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>加载中...</span>
          ) : plugins.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
              暂无插件。在 ~/.wzxclaw/plugins/ 目录下安装。
            </div>
          ) : (
            plugins.map(plugin => (
              <div key={plugin.id} style={{
                padding: 'var(--sp-2) var(--sp-3)',
                background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-md)',
                marginBottom: 'var(--sp-1)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
                  <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 500 }}>{plugin.name}</span>
                  {plugin.version && (
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>v{plugin.version}</span>
                  )}
                  <span style={{
                    fontSize: 'var(--font-size-xs)',
                    color: plugin.enabled ? 'var(--status-connected)' : 'var(--text-muted)',
                  }}>
                    {plugin.enabled ? '已启用' : '已禁用'}
                  </span>
                </div>
                {plugin.description && (
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>{plugin.description}</div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Indexing Tab */}
      {activeTab === 'indexing' && (
        <div>
          {indexingStatus ? (
            <div style={{ padding: 'var(--sp-3)', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ fontSize: 'var(--font-size-sm)', marginBottom: 'var(--sp-1)' }}>
                状态: <span style={{ color: indexingStatus.available ? 'var(--status-connected)' : 'var(--text-muted)' }}>
                  {indexingStatus.available ? '可用' : '不可用'}
                </span>
              </div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                后端: {indexingStatus.backend}
              </div>
              {indexingStatus.lastIndexed && (
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                  最后索引: {new Date(indexingStatus.lastIndexed).toLocaleString()}
                </div>
              )}
            </div>
          ) : (
            <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>加载中...</span>
          )}
        </div>
      )}

      {/* Insights Tab */}
      {activeTab === 'insights' && (
        <div>
          {insightsStatus ? (
            <div style={{ padding: 'var(--sp-3)', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ fontSize: 'var(--font-size-sm)', marginBottom: 'var(--sp-1)' }}>
                状态: <span style={{ color: insightsStatus.available ? 'var(--status-connected)' : 'var(--text-muted)' }}>
                  {insightsStatus.available ? '可用' : '不可用'}
                </span>
              </div>
              {insightsStatus.reportExists && insightsStatus.lastGenerated && (
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                  报告生成于: {new Date(insightsStatus.lastGenerated).toLocaleString()}
                </div>
              )}
            </div>
          ) : (
            <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>加载中...</span>
          )}
        </div>
      )}
    </div>
  )
}

// ---- 添加主机表单 ----

function AddHostForm({ onSave, onCancel }: {
  onSave: (input: { name: string; address: string; port: number; username: string; authType: string; description?: string }) => Promise<void>
  onCancel: () => void
}): React.ReactElement {
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('root')
  const [authType, setAuthType] = useState<'password' | 'key'>('key')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async () => {
    if (!name || !address) return
    setSaving(true)
    try {
      await onSave({ name, address, port: parseInt(port) || 22, username, authType, description: description || undefined })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ padding: 'var(--sp-3)', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-md)', marginTop: 'var(--sp-2)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
        <input placeholder="名称" value={name} onChange={e => setName(e.target.value)} className="settings-input" />
        <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
          <input placeholder="地址" value={address} onChange={e => setAddress(e.target.value)} className="settings-input" style={{ flex: 2 }} />
          <input placeholder="端口" value={port} onChange={e => setPort(e.target.value)} className="settings-input" style={{ flex: 1 }} />
        </div>
        <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
          <input placeholder="用户名" value={username} onChange={e => setUsername(e.target.value)} className="settings-input" style={{ flex: 1 }} />
          <select value={authType} onChange={e => setAuthType(e.target.value as 'password' | 'key')} className="settings-select" style={{ flex: 1 }}>
            <option value="key">密钥</option>
            <option value="password">密码</option>
          </select>
        </div>
        <input placeholder="描述（可选）" value={description} onChange={e => setDescription(e.target.value)} className="settings-input" />
        <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
          <button onClick={handleSubmit} disabled={saving || !name || !address} style={{
            padding: 'var(--sp-1) var(--sp-3)', background: 'var(--bg-active)',
            border: 'none', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
            cursor: saving ? 'wait' : 'pointer', fontSize: 'var(--font-size-sm)',
          }}>
            {saving ? '保存中...' : '保存'}
          </button>
          <button onClick={onCancel} style={{
            padding: 'var(--sp-1) var(--sp-3)', background: 'transparent',
            border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
            color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 'var(--font-size-sm)',
          }}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
