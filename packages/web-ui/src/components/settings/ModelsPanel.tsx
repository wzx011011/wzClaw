// ============================================================
// ModelsPanel — 模型配置
//
// 选择默认 LLM 模型（通过 DataSource 获取可用模型列表）
// ============================================================

import { useState, useEffect } from 'react'
import { useDataSource } from '../../providers/DataSourceProvider'
import { useToastStore } from '../../stores/toast-store'

const MODEL_STORAGE_KEY = 'wzxclaw-model-config'

interface ModelInfo {
  id: string
  name: string
  provider: string
  contextLength?: number
  description?: string
}

// 内置常用模型列表（后端无法返回时的回退）
const BUILTIN_MODELS: ModelInfo[] = [
  { id: 'glm-5-plus', name: 'GLM-5 Plus', provider: 'zhipu', contextLength: 128000 },
  { id: 'glm-5', name: 'GLM-5', provider: 'zhipu', contextLength: 128000 },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic', contextLength: 200000 },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', provider: 'anthropic', contextLength: 200000 },
  { id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', contextLength: 64000 },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextLength: 128000 },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', contextLength: 128000 },
]

const PROVIDER_COLORS: Record<string, string> = {
  zhipu: '#00b96b',
  anthropic: '#c96442',
  openai: '#19c37d',
  deepseek: '#4d6bfe',
}

function loadModel(): string {
  try { return JSON.parse(localStorage.getItem(MODEL_STORAGE_KEY) ?? 'null') ?? '' } catch { return '' }
}

export default function ModelsPanel(): React.ReactElement {
  const ds = useDataSource()
  const toast = useToastStore((s) => s.show)
  const [models, setModels] = useState<ModelInfo[]>(BUILTIN_MODELS)
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState(loadModel)

  useEffect(() => {
    if (!ds?.isConnected()) return
    setLoading(true)
    ;(ds as any).listModels?.().then((list: ModelInfo[]) => {
      if (list?.length) setModels(list)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [ds])

  function handleSave() {
    try { localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(selectedModel)) } catch { /**/ }
    toast('模型配置已保存', 'success')
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">模型配置</h3>
      <div className="settings-card">
        <div className="settings-field">
          <label className="settings-label">默认模型</label>
          <span className="settings-field-hint">选择 Agent 对话使用的默认 LLM 模型</span>
        </div>

        {loading ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', padding: '12px 0' }}>
            从 Agent Server 加载模型列表...
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {models.map((m) => (
              <label key={m.id} style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${selectedModel === m.id ? 'var(--accent)' : 'var(--border)'}`,
                background: selectedModel === m.id ? 'var(--bg-secondary)' : 'transparent',
                cursor: 'pointer',
              }}>
                <input
                  type="radio"
                  name="model"
                  value={m.id}
                  checked={selectedModel === m.id}
                  onChange={() => setSelectedModel(m.id)}
                  style={{ accentColor: 'var(--accent)' }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)', fontWeight: 500 }}>
                      {m.name}
                    </span>
                    <span style={{
                      fontSize: '10px',
                      padding: '1px 5px',
                      borderRadius: '9999px',
                      background: `${PROVIDER_COLORS[m.provider] ?? '#666'}20`,
                      color: PROVIDER_COLORS[m.provider] ?? '#999',
                    }}>
                      {m.provider}
                    </span>
                  </div>
                  {m.contextLength && (
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      {(m.contextLength / 1000).toFixed(0)}K 上下文
                    </span>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}

        <button className="settings-save-btn" onClick={handleSave} style={{ marginTop: '12px' }}>
          保存模型设置
        </button>
      </div>
    </div>
  )
}
