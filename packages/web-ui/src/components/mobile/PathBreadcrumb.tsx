// ============================================================
// PathBreadcrumb — 路径面包屑导航
//
// 可点击的路径段，水平滚动溢出。
// ============================================================

import React from 'react'

interface PathBreadcrumbProps {
  path: string
  onNavigate: (path: string) => void
}

export default function PathBreadcrumb({ path, onNavigate }: PathBreadcrumbProps): React.ReactElement {
  const segments = path.split('/').filter(Boolean)

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '2px',
      padding: 'var(--sp-2) var(--sp-3)',
      borderBottom: '1px solid var(--border)',
      overflowX: 'auto',
      WebkitOverflowScrolling: 'touch',
      flexShrink: 0,
      fontSize: 'var(--font-size-xs)',
      color: 'var(--text-muted)',
    }}>
      {/* 根目录 */}
      <button
        onClick={() => onNavigate('/')}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          padding: '2px 4px',
          fontSize: 'inherit',
          touchAction: 'manipulation',
        }}
      >
        /
      </button>

      {segments.map((seg, i) => {
        const segPath = '/' + segments.slice(0, i + 1).join('/')
        const isLast = i === segments.length - 1

        return (
          <React.Fragment key={segPath}>
            <span style={{ opacity: 0.4 }}>/</span>
            <button
              onClick={() => !isLast && onNavigate(segPath)}
              style={{
                background: 'transparent',
                border: 'none',
                color: isLast ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: isLast ? 600 : 400,
                cursor: isLast ? 'default' : 'pointer',
                padding: '2px 4px',
                fontSize: 'inherit',
                touchAction: 'manipulation',
                whiteSpace: 'nowrap',
              }}
            >
              {seg}
            </button>
          </React.Fragment>
        )
      })}
    </div>
  )
}
