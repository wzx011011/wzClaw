// ============================================================
// AgentsPanel — Agent 配置面板
//
// 查看并配置自定义 Agent 参数（max turns, 系统提示词, 权限模式）
// ============================================================

import { useState } from 'react'
import { useToastStore } from '../../stores/toast-store'

const AGENT_STORAGE_KEY = 'wzxclaw-agent-config'

interface AgentConfig {
  maxTurns: number
  permissionMode: string
  autoCompact: boolean
  compactThreshold: number
  systemPromptOverride: string
}

function loadAgentConfig(): AgentConfig {
  try {
    const raw = localStorage.getItem(AGENT_STORAGE_KEY)
    if (!raw) return { maxTurns: 20, permissionMode: 'accept-edits', autoCompact: true, compactThreshold: 80, systemPromptOverride: '' }
    const p = JSON.parse(raw) as Partial<AgentConfig>
    return {
      maxTurns: typeof p.maxTurns === 'number' ? p.maxTurns : 20,
      permissionMode: typeof p.permissionMode === 'string' ? p.permissionMode : 'accept-edits',
      autoCompact: typeof p.autoCompact === 'boolean' ? p.autoCompact : true,
      compactThreshold: typeof p.compactThreshold === 'number' ? p.compactThreshold : 80,
      systemPromptOverride: typeof p.systemPromptOverride === 'string' ? p.systemPromptOverride : '',
    }
  } catch { return { maxTurns: 20, permissionMode: 'accept-edits', autoCompact: true, compactThreshold: 80, systemPromptOverride: '' } }
}

const PERMISSION_MODES = [
  { value: 'always-ask', label: '每次询问', description: '所有工具操作都需要用户确认' },
  { value: 'accept-edits', label: '自动接受编辑', description: '文件编辑自动执行，危险操作询问' },
  { value: 'plan', label: '计划模式', description: '先展示执行计划，再批量确认' },
  { value: 'bypass', label: '完全自动', description: '所有操作自动执行，无需确认（高风险）' },
]

export default function AgentsPanel(): React.ReactElement {
  const toast = useToastStore((s) => s.show)
  const initial = loadAgentConfig()
  const [maxTurns, setMaxTurns] = useState(String(initial.maxTurns))
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPromptOverride)
  const [permissionMode, setPermissionMode] = useState(initial.permissionMode)
  const [autoCompact, setAutoCompact] = useState(initial.autoCompact)
  const [compactThreshold, setCompactThreshold] = useState(String(initial.compactThreshold))

  function handleSave() {
    const turns = parseInt(maxTurns, 10)
    if (isNaN(turns) || turns < 1 || turns > 200) {
      toast('最大轮次须在 1~200 之间', 'error')
      return
    }
    const threshold = parseInt(compactThreshold, 10)
    if (isNaN(threshold) || threshold < 10 || threshold > 100) {
      toast('压缩阈值须在 10~100 之间', 'error')
      return
    }
    try {
      localStorage.setItem(AGENT_STORAGE_KEY, JSON.stringify({
        maxTurns: turns,
        permissionMode,
        autoCompact,
        compactThreshold: threshold,
        systemPromptOverride: systemPrompt || '',
      }))
    } catch { /**/ }
    toast('Agent 配置已保存', 'success')
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Agent 配置</h3>
      <div className="settings-card">
        {/* 权限模式 */}
        <div className="settings-field">
          <label className="settings-label">权限模式</label>
          <span className="settings-field-hint">控制工具执行前是否需要用户批准</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
            {PERMISSION_MODES.map((m) => (
              <label key={m.value} style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                padding: '8px 12px',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${permissionMode === m.value ? 'var(--accent)' : 'var(--border)'}`,
                background: permissionMode === m.value ? 'var(--bg-secondary)' : 'transparent',
                cursor: 'pointer',
              }}>
                <input
                  type="radio"
                  name="permission-mode"
                  value={m.value}
                  checked={permissionMode === m.value}
                  onChange={() => setPermissionMode(m.value)}
                  style={{ accentColor: 'var(--accent)', marginTop: '2px' }}
                />
                <div>
                  <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)', fontWeight: 500 }}>
                    {m.label}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {m.description}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* 最大轮次 */}
        <div className="settings-field">
          <label className="settings-label" htmlFor="max-turns">最大对话轮次</label>
          <input
            id="max-turns"
            type="number"
            className="settings-input"
            value={maxTurns}
            min={1}
            max={200}
            onChange={(e) => setMaxTurns(e.target.value)}
            style={{ width: '80px' }}
          />
          <span className="settings-field-hint">单次任务最多进行的 Agent 轮次（1~200）</span>
        </div>

        {/* 上下文自动压缩 */}
        <div className="settings-field">
          <label className="settings-label">自动压缩上下文</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoCompact}
              onChange={(e) => setAutoCompact(e.target.checked)}
              style={{ accentColor: 'var(--accent)', width: '14px', height: '14px' }}
            />
            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
              上下文超过阈值时自动压缩
            </span>
          </label>
          {autoCompact && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
              <input
                type="number"
                className="settings-input"
                value={compactThreshold}
                min={10}
                max={100}
                onChange={(e) => setCompactThreshold(e.target.value)}
                style={{ width: '60px' }}
              />
              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>% 时触发</span>
            </div>
          )}
        </div>

        {/* 系统提示词覆盖 */}
        <div className="settings-field">
          <label className="settings-label" htmlFor="sys-prompt-override">系统提示词（覆盖）</label>
          <textarea
            id="sys-prompt-override"
            className="settings-input"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="留空则使用 Agent Server 默认系统提示词"
            rows={6}
            style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '11px', lineHeight: 1.5 }}
          />
          <span className="settings-field-hint">自定义内容将追加至默认系统提示词末尾</span>
        </div>

        <button className="settings-save-btn" onClick={handleSave}>保存 Agent 配置</button>
      </div>
    </div>
  )
}
