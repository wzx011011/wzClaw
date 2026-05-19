// ============================================================
// ContextMenu — 通用右键菜单组件
// 从桌面端 components/ui/ContextMenu.tsx 提取
// 支持 items 数组（label, onClick, danger, separator, shortcut）
// 不依赖 Electron，纯 React + CSS
// ============================================================

import { useEffect, useCallback } from 'react'

/** 右键菜单项 */
export interface ContextMenuItem {
  /** 显示文本 */
  label: string
  /** 点击回调 */
  onClick: () => void
  /** 是否禁用 */
  disabled?: boolean
  /** 是否显示为分割线（label 字段忽略） */
  separator?: boolean
  /** 快捷键提示文本（可选，显示在右侧） */
  shortcut?: string
  /** 是否为危险操作（红色文字） */
  danger?: boolean
}

interface ContextMenuProps {
  /** 菜单弹出位置 X（页面坐标） */
  x: number
  /** 菜单弹出位置 Y（页面坐标） */
  y: number
  /** 菜单项列表 */
  items: ContextMenuItem[]
  /** 关闭菜单回调 */
  onClose: () => void
}

/**
 * ContextMenu — 右键菜单
 *
 * 特性：
 * - 点击外部或按 Escape 关闭
 * - 自动调整位置避免超出屏幕
 * - 支持 disabled / separator / shortcut / danger 标记
 */
export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps): React.ReactElement {
  // 点击外部关闭
  const handleClickOutside = useCallback(() => {
    onClose()
  }, [onClose])

  useEffect(() => {
    window.addEventListener('click', handleClickOutside)
    return () => window.removeEventListener('click', handleClickOutside)
  }, [handleClickOutside])

  // Escape 关闭
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

  // 自动调整位置避免超出屏幕
  useEffect(() => {
    const el = document.querySelector('.context-menu') as HTMLElement | null
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
    <div className="context-menu" role="menu" style={{ left: x, top: y }}>
      {items.map((item, index) => (
        item.separator && index > 0 ? (
          <div key={index} className="context-menu-separator" />
        ) : (
          <button
            key={index}
            className={`context-menu-item${item.disabled ? ' disabled' : ''}${item.danger ? ' danger' : ''}`}
            onClick={() => {
              if (!item.disabled) {
                item.onClick()
                onClose()
              }
            }}
            disabled={item.disabled}
            role="menuitem"
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
          </button>
        )
      ))}
    </div>
  )
}
