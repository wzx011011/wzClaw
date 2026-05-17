// ============================================================
// FileItem — 文件/目录列表行
//
// 左：类型图标 | 中：文件名 | 48px 行高
// ============================================================

import React from 'react'
import type { FileTreeNode } from '../../data-source/types'

interface FileItemProps {
  item: FileTreeNode
  onOpen: (item: FileTreeNode) => void
}

export default function FileItem({ item, onOpen }: FileItemProps): React.ReactElement {
  const isDir = item.type === 'directory'

  return (
    <button
      className="file-item-row"
      onClick={() => onOpen(item)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        width: '100%',
        height: '48px',
        padding: '0 var(--sp-3)',
        background: 'transparent',
        border: 'none',
        borderBottom: '1px solid var(--border)',
        color: 'var(--text-primary)',
        cursor: 'pointer',
        textAlign: 'left' as const,
        touchAction: 'manipulation',
        WebkitTapHighlightColor: 'transparent',
        transition: 'background 100ms ease',
      }}
    >
      {/* 类型图标 */}
      {isDir ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--accent)" stroke="none">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      )}

      {/* 文件名 */}
      <span style={{
        flex: 1,
        fontSize: 'var(--font-size-sm)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {item.name}
      </span>

      {/* 箭头（目录） */}
      {isDir && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      )}
    </button>
  )
}
