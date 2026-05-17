// ============================================================
// FileBrowserPage — 手机端文件浏览器
//
// 显示目录列表、面包屑导航、Hand 离线占位。
// ============================================================

import React, { useEffect } from 'react'
import type { StoreApi } from 'zustand'
import type { FileBrowserStore } from '../../stores/file-browser-store'
import FileItem from '../../components/mobile/FileItem'
import PathBreadcrumb from '../../components/mobile/PathBreadcrumb'
import type { FileTreeNode } from '../../data-source/types'

interface FileBrowserPageProps {
  store: StoreApi<FileBrowserStore>
  onFileOpen: (file: FileTreeNode) => void
  hasFs: boolean
}

export default function FileBrowserPage({ store, onFileOpen, hasFs }: FileBrowserPageProps): React.ReactElement {
  const state = store.getState()
  const { currentPath, items, loading, error } = state

  useEffect(() => {
    // 首次加载自动导航到当前路径
    if (items.length === 0 && !loading && !error) {
      store.getState().navigate(currentPath)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasFs) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--text-secondary)',
        gap: 'var(--sp-3)',
        padding: 'var(--sp-4)',
        textAlign: 'center' as const,
      }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span>文件浏览需要 Hand 连接</span>
      </div>
    )
  }

  if (error) {
    const isOffline = error.includes('Hand') || error.includes('离线')
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--text-secondary)',
        gap: 'var(--sp-3)',
        padding: 'var(--sp-4)',
        textAlign: 'center' as const,
      }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
          <line x1="1" y1="1" x2="23" y2="23" />
          <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
          <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
          <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
          <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <line x1="12" y1="20" x2="12.01" y2="20" />
        </svg>
        <span>{isOffline ? 'Hand 离线' : error}</span>
        {isOffline && <span style={{ fontSize: 'var(--font-size-xs)' }}>请确保 NAS Hand 正在运行</span>}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PathBreadcrumb
        path={currentPath}
        onNavigate={(path) => store.getState().navigate(path)}
      />
      {loading ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 1,
          color: 'var(--text-secondary)',
          fontSize: 'var(--font-size-sm)',
        }}>
          <span className="thinking-dot" /> 加载中...
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto' }}>
          {items.map((item) => (
            <FileItem
              key={item.path}
              item={item}
              onOpen={(item) => {
                if (item.type === 'directory') {
                  store.getState().navigate(item.path)
                } else {
                  onFileOpen(item)
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
