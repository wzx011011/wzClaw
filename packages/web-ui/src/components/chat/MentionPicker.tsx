// ============================================================
// MentionPicker — @提及选择器
//
// 用户在输入框输入 '@' 后弹出，列出可提及的文件/符号/会话。
// 当前实现支持：文件路径提及（需 FsChannel）、Hand 提及。
// ============================================================

import React, { useEffect, useRef, useState, useMemo } from 'react'

export interface MentionItem {
  /** 唯一 key */
  id: string
  /** 显示名称 */
  label: string
  /** 提及后插入到输入框的文本 */
  value: string
  /** 图标类型 */
  type: 'file' | 'hand' | 'session' | 'symbol'
  /** 描述（可选，显示在右侧） */
  description?: string
}

interface MentionPickerProps {
  /** '@' 后输入的搜索词 */
  query: string
  /** 可提及项目列表（由父组件提供，按需加载） */
  items: MentionItem[]
  /** 是否在加载中 */
  loading?: boolean
  /** 选中某项时的回调 */
  onSelect: (item: MentionItem) => void
  /** 关闭选择器 */
  onClose: () => void
  /** 锚点元素（用于定位） */
  anchorRef: React.RefObject<HTMLElement>
}

const TYPE_ICONS: Record<MentionItem['type'], React.ReactElement> = {
  file: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" /><polyline points="13 2 13 9 20 9" />
    </svg>
  ),
  hand: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 11V6a2 2 0 00-4 0v5M14 10V4a2 2 0 00-4 0v6M10 10.5V6a2 2 0 00-4 0v8" />
      <path d="M6 14v0a6 6 0 006 6h2a6 6 0 006-6v-3" />
    </svg>
  ),
  session: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  ),
  symbol: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
    </svg>
  ),
}

const TYPE_COLORS: Record<MentionItem['type'], string> = {
  file:    'var(--accent, #7b6ef6)',
  hand:    'var(--tool-completed, #22c55e)',
  session: 'var(--warning, #f59e0b)',
  symbol:  'var(--text-secondary, #888)',
}

export default function MentionPicker({ query, items, loading, onSelect, onClose, anchorRef }: MentionPickerProps): React.ReactElement | null {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    if (!query.trim()) return items.slice(0, 12)
    const lower = query.toLowerCase()
    return items.filter((i) => i.label.toLowerCase().includes(lower) || i.value.toLowerCase().includes(lower)).slice(0, 12)
  }, [items, query])

  // 键盘导航
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex((i) => Math.max(i - 1, 0)) }
      if (e.key === 'Enter') { e.preventDefault(); filtered[selectedIndex] && onSelect(filtered[selectedIndex]) }
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [filtered, selectedIndex, onSelect, onClose])

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

  if (!loading && filtered.length === 0) return null

  const anchor = anchorRef.current
  const bottom = anchor ? (window.innerHeight - anchor.getBoundingClientRect().top + 8) : 60
  const left = anchor ? anchor.getBoundingClientRect().left : 12

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        zIndex: 1000,
        bottom,
        left,
        background: 'var(--bg-secondary, #2a2a3e)',
        border: '1px solid var(--border, #333)',
        borderRadius: 'var(--radius-sm, 4px)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        width: '340px',
        maxHeight: '280px',
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
        @提及
      </div>

      {/* 加载中 */}
      {loading && (
        <div style={{ padding: '12px', color: 'var(--text-secondary, #888)', fontSize: '12px', textAlign: 'center' }}>
          加载中...
        </div>
      )}

      {/* 列表 */}
      {!loading && filtered.map((item, idx) => (
        <button
          key={item.id}
          onClick={() => onSelect(item)}
          onMouseEnter={() => setSelectedIndex(idx)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 12px',
            background: idx === selectedIndex ? 'var(--bg-hover, #3a3a5e)' : 'transparent',
            border: 'none',
            color: 'var(--text-primary, #e0e0e0)',
            cursor: 'pointer',
            textAlign: 'left',
            fontSize: 'var(--font-size-sm, 12px)',
          }}
        >
          <span style={{ color: TYPE_COLORS[item.type], flexShrink: 0 }}>
            {TYPE_ICONS[item.type]}
          </span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.label}
          </span>
          {item.description && (
            <span style={{ fontSize: '11px', color: 'var(--text-muted, #666)', flexShrink: 0 }}>
              {item.description}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
