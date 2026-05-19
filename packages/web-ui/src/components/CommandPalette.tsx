// ============================================================
// CommandPalette — 全局命令面板
//
// Ctrl+Shift+P 打开，读取 command-store 中注册的命令，
// 支持搜索过滤 + 键盘导航（↑↓ Enter Escape）。
// ============================================================

import React, { useEffect, useRef, useState } from 'react'
import { useCommandStore } from '../stores/command-store'

export default function CommandPalette(): React.ReactElement | null {
  const { open, query, setQuery, closePalette, filteredCommands, execute } = useCommandStore()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = filteredCommands()

  // 打开时聚焦输入框
  useEffect(() => {
    if (open) {
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  // 键盘导航
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closePalette(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex((i) => Math.min(i + 1, commands.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex((i) => Math.max(i - 1, 0)); return }
      if (e.key === 'Enter') {
        e.preventDefault()
        const cmd = commands[selectedIndex]
        if (cmd) execute(cmd.id)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, commands, selectedIndex, closePalette, execute])

  // 选中项滚动到可视区域
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const item = list.querySelector(`[data-idx="${selectedIndex}"]`) as HTMLElement | null
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (!open) return null

  // 按 category 分组
  const grouped: Record<string, typeof commands> = {}
  for (const cmd of commands.slice(0, 40)) {
    const cat = cmd.category ?? '命令'
    grouped[cat] = grouped[cat] ?? []
    grouped[cat].push(cmd)
  }

  // 全局 flat index 映射
  const flatCommands = commands.slice(0, 40)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '15vh',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) closePalette() }}
    >
      <div style={{
        width: 560,
        maxWidth: '90vw',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        maxHeight: '60vh',
      }}>
        {/* 搜索框 */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          gap: 8,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
            placeholder="搜索命令..."
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text-primary)',
              fontSize: 'var(--font-size-sm)',
            }}
          />
          <kbd style={{
            fontSize: 10,
            padding: '2px 6px',
            background: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 3,
            color: 'var(--text-muted)',
          }}>Esc</kbd>
        </div>

        {/* 命令列表 */}
        <div ref={listRef} style={{ overflowY: 'auto', flex: 1 }}>
          {flatCommands.length === 0 && (
            <div style={{
              padding: '24px',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 'var(--font-size-sm)',
            }}>
              {query ? '没有匹配的命令' : '暂无注册命令'}
            </div>
          )}
          {Object.entries(grouped).map(([category, cmds]) => (
            <div key={category}>
              <div style={{
                padding: '6px 14px 3px',
                fontSize: 10,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                fontWeight: 600,
              }}>
                {category}
              </div>
              {cmds.map((cmd) => {
                const flatIdx = flatCommands.indexOf(cmd)
                const isSelected = flatIdx === selectedIndex
                return (
                  <div
                    key={cmd.id}
                    data-idx={flatIdx}
                    onClick={() => execute(cmd.id)}
                    onMouseEnter={() => setSelectedIndex(flatIdx)}
                    style={{
                      padding: '7px 14px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      cursor: 'pointer',
                      background: isSelected ? 'var(--accent)' : 'transparent',
                      color: isSelected ? '#fff' : 'var(--text-primary)',
                      fontSize: 'var(--font-size-sm)',
                      userSelect: 'none',
                    }}
                  >
                    <span style={{ flex: 1 }}>{cmd.title}</span>
                    {cmd.shortcut && (
                      <kbd style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        background: isSelected ? 'rgba(255,255,255,0.2)' : 'var(--bg-primary)',
                        border: `1px solid ${isSelected ? 'rgba(255,255,255,0.3)' : 'var(--border)'}`,
                        borderRadius: 3,
                        color: isSelected ? '#fff' : 'var(--text-muted)',
                        whiteSpace: 'nowrap',
                      }}>
                        {cmd.shortcut}
                      </kbd>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        {/* 底部提示 */}
        <div style={{
          padding: '6px 14px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          gap: 16,
          fontSize: 11,
          color: 'var(--text-muted)',
        }}>
          <span><kbd style={{ marginRight: 4, padding: '1px 4px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 2 }}>↑↓</kbd>导航</span>
          <span><kbd style={{ marginRight: 4, padding: '1px 4px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 2 }}>Enter</kbd>执行</span>
          <span><kbd style={{ marginRight: 4, padding: '1px 4px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 2 }}>Esc</kbd>关闭</span>
          {commands.length > 0 && <span style={{ marginLeft: 'auto' }}>{commands.length} 条结果</span>}
        </div>
      </div>
    </div>
  )
}
