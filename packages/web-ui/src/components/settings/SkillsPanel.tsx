// ============================================================
// SkillsPanel — 技能知识查看器
//
// 展示 Agent Server 上配置的 skills / commands / memory
// ============================================================

import { useState, useEffect } from 'react'
import { useDataSource } from '../../providers/DataSourceProvider'

interface KnowledgeData {
  skills: string
  commands: string
  memory: string
}

type KnowledgeTab = 'skills' | 'commands' | 'memory'

const TAB_LABELS: Record<KnowledgeTab, string> = {
  skills: '技能',
  commands: '命令',
  memory: '记忆',
}

export default function SkillsPanel(): React.ReactElement {
  const ds = useDataSource()
  const [knowledge, setKnowledge] = useState<KnowledgeData | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<KnowledgeTab>('skills')

  useEffect(() => {
    if (!ds?.isConnected()) return
    setLoading(true)
    ds.getKnowledge?.().then((k) => {
      setKnowledge(k)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [ds])

  const currentContent = knowledge?.[activeTab] ?? ''

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">技能 / 知识</h3>
      <div className="settings-card">
        {/* Tab 切换 */}
        <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
          {(Object.keys(TAB_LABELS) as KnowledgeTab[]).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{
              padding: '5px 14px',
              borderRadius: 'var(--radius-sm)',
              border: `1px solid ${activeTab === tab ? 'var(--accent)' : 'var(--border)'}`,
              background: activeTab === tab ? 'var(--accent)' : 'transparent',
              color: activeTab === tab ? '#fff' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 'var(--font-size-sm)',
            }}>
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>

        {loading && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', padding: '12px 0' }}>
            加载中...
          </div>
        )}

        {!loading && !ds?.isConnected() && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', padding: '20px 0', textAlign: 'center' }}>
            需要连接 Agent Server 才能查看技能知识库
          </div>
        )}

        {!loading && knowledge && (
          <div>
            {currentContent.trim() ? (
              <pre style={{
                fontSize: '11px',
                color: 'var(--text-secondary)',
                background: 'var(--bg-primary)',
                padding: '12px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '420px',
                overflow: 'auto',
                lineHeight: 1.6,
                margin: 0,
              }}>
                {currentContent}
              </pre>
            ) : (
              <div style={{
                color: 'var(--text-secondary)',
                fontSize: 'var(--font-size-sm)',
                padding: '20px 0',
                textAlign: 'center',
              }}>
                {activeTab === 'skills' && '暂无技能文件（~/.wzxclaw/skills/）'}
                {activeTab === 'commands' && '暂无自定义命令（~/.wzxclaw/commands/）'}
                {activeTab === 'memory' && '暂无记忆文件（~/.wzxclaw/memory/）'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
