// ============================================================
// CommandsPanel — 已注册命令面板
//
// 展示从 command-store 注册的所有命令（本地 + 服务端）
// ============================================================

import { useCommandStore } from '../../stores/command-store'

export default function CommandsPanel(): React.ReactElement {
  const allCommands = useCommandStore((s) => s.filteredCommands)()

  const byCategory = allCommands.reduce<Record<string, typeof allCommands>>((acc, cmd) => {
    const cat = cmd.category ?? '通用'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(cmd)
    return acc
  }, {})

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">命令列表</h3>
      <div className="settings-card">
        <div className="settings-field">
          <span className="settings-field-hint">
            在聊天输入框中输入 / 触发命令面板，或使用快捷键 Ctrl+Shift+P
          </span>
        </div>

        {allCommands.length === 0 && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', padding: '20px 0', textAlign: 'center' }}>
            暂无已注册命令
          </div>
        )}

        {Object.entries(byCategory).map(([category, cmds]) => (
          <div key={category} style={{ marginBottom: '16px' }}>
            <div style={{
              fontSize: '10px',
              fontWeight: 600,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: '6px',
              padding: '0 2px',
            }}>
              {category}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {cmds.map((cmd) => (
                <div key={cmd.id} style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '7px 10px',
                  background: 'var(--bg-primary)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  gap: '10px',
                  opacity: cmd.disabled ? 0.5 : 1,
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {cmd.icon && (
                        <span style={{ fontSize: '14px', lineHeight: 1 }}>{cmd.icon}</span>
                      )}
                      <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)', fontWeight: 500 }}>
                        {cmd.title}
                      </span>
                    </div>
                  </div>
                  {cmd.shortcut && (
                    <kbd style={{
                      fontSize: '10px',
                      padding: '2px 5px',
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border)',
                      borderRadius: '3px',
                      color: 'var(--text-secondary)',
                      fontFamily: 'inherit',
                      whiteSpace: 'nowrap',
                    }}>
                      {cmd.shortcut}
                    </kbd>
                  )}
                  {cmd.disabled && (
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', padding: '1px 5px', borderRadius: '3px', border: '1px solid var(--border)' }}>
                      不可用
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
