// ============================================================
// SlashCommandPicker — 斜线命令选择器
//
// 用户在输入框输入 '/' 后弹出，列出可用命令供选择。
// 通过 command-store 读取注册的命令列表。
// ============================================================

import React, { useEffect, useRef, useState } from 'react'
import { useCommandStore } from '../../stores/command-store'

interface SlashCommandPickerProps {
  /** 当前输入的命令前缀（'/' 之后的部分） */
  query: string
  /** 选中命令时的回调（返回命令模板字符串替换输入框） */
  onSelect: (template: string) => void
  /** 关闭选择器 */
  onClose: () => void
  /** 底部偏移（相对输入框顶部）*/
  anchorRef: React.RefObject<HTMLElement>
}

export default function SlashCommandPicker({ query, onSelect, onClose, anchorRef }: SlashCommandPickerProps): React.ReactElement | null {
  const filteredCommands = useCommandStore((s) => s.filteredCommands)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // 过滤 / 开头的命令
  const commands = React.useMemo(() => {
    const all = filteredCommands()
    const lower = query.toLowerCase()
    return all.filter((c) =>
      c.id.startsWith('/') || c.category === '/' || c.title.toLowerCase().startsWith(lower)
    ).slice(0, 12)
  }, [filteredCommands, query])

  // 键盘导航
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex((i) => Math.min(i + 1, commands.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex((i) => Math.max(i - 1, 0)) }
      if (e.key === 'Enter') { e.preventDefault(); commands[selectedIndex] && onSelect(commands[selectedIndex].title) }
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [commands, selectedIndex, onSelect, onClose])

  // 点击外部关闭
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [onClose])

  if (commands.length === 0) return null

  // 定位：在锚点元素上方
  const anchor = anchorRef.current
  const style: React.CSSProperties = {
    position: 'fixed',
    zIndex: 1000,
    bottom: anchor ? (window.innerHeight - anchor.getBoundingClientRect().top + 8) : 60,
    left: anchor ? anchor.getBoundingClientRect().left : 12,
  }

  return (
    <div
      ref={containerRef}
      style={{
        ...style,
        background: 'var(--bg-secondary, #2a2a3e)',
        border: '1px solid var(--border, #333)',
        borderRadius: 'var(--radius-sm, 4px)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        width: '320px',
        maxHeight: '260px',
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* 标题 */}
      <div style={{
        padding: '6px 10px',
        fontSize: '10px',
        color: 'var(--text-muted, #666)',
        borderBottom: '1px solid var(--border, #333)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}>
        斜线命令
      </div>

      {/* 列表 */}
      {commands.map((cmd, idx) => (
        <button
          key={cmd.id}
          onClick={() => onSelect(cmd.title)}
          onMouseEnter={() => setSelectedIndex(idx)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            background: idx === selectedIndex ? 'var(--bg-hover, #3a3a5e)' : 'transparent',
            border: 'none',
            color: 'var(--text-primary, #e0e0e0)',
            cursor: 'pointer',
            textAlign: 'left',
            fontSize: 'var(--font-size-sm, 12px)',
            gap: '8px',
          }}
        >
          <span style={{ fontWeight: 500 }}>{cmd.title}</span>
          {cmd.shortcut && (
            <kbd style={{
              fontSize: '10px',
              padding: '1px 4px',
              background: 'var(--bg-primary, #1a1a2e)',
              border: '1px solid var(--border, #333)',
              borderRadius: '3px',
              color: 'var(--text-secondary, #888)',
              fontFamily: 'monospace',
            }}>
              {cmd.shortcut}
            </kbd>
          )}
        </button>
      ))}
    </div>
  )
}
