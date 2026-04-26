import React, { useEffect, useCallback } from 'react'

// ============================================================
// ContextMenu — 共享右键菜单组件
// 统一 SessionList 和 FileExplorer 的右键菜单样式和行为
// ============================================================

export interface ContextMenuItem {
  label: string
  onClick: () => void
  disabled?: boolean
  separator?: boolean
  shortcut?: string
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps): JSX.Element {
  const handleClickOutside = useCallback(() => {
    onClose()
  }, [onClose])

  useEffect(() => {
    // Close on any click outside
    window.addEventListener('click', handleClickOutside)
    return () => window.removeEventListener('click', handleClickOutside)
  }, [handleClickOutside])

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Adjust position to avoid going off-screen
  useEffect(() => {
    const el = document.querySelector('.context-menu')
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.right > window.innerWidth) {
      el.style.left = `${x - rect.width}px`
    }
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${y - rect.height}px`
    }
  }, [x, y])

  return (
    <div className="context-menu" style={{ left: x, top: y }}>
      {items.map((item, index) => (
        item.separator && index > 0 ? (
          <div key={index} className="context-menu-separator" />
        ) : (
          <button
            key={index}
            className={`context-menu-item${item.disabled ? ' disabled' : ''}`}
            onClick={() => {
              if (!item.disabled) {
                item.onClick()
                onClose()
              }
            }}
            disabled={item.disabled}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
          </button>
        )
      ))}
    </div>
  )
}
