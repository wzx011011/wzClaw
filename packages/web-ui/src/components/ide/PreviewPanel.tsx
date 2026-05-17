// ============================================================
// PreviewPanel — URL 预览面板
//
// iframe 预览，支持 URL 地址栏和刷新。
// 通过 DataSource.preview 通道管理 URL 状态。
// ============================================================

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useDataSource } from '../../providers/DataSourceProvider'

export default function PreviewPanel(): React.ReactElement {
  const dataSource = useDataSource()
  const [url, setUrl] = useState<string | null>(null)
  const [inputUrl, setInputUrl] = useState('')
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // 订阅 URL 变更
  useEffect(() => {
    if (!dataSource?.preview) return
    return dataSource.preview.onUrlChange((newUrl) => {
      setUrl(newUrl)
      if (newUrl) setInputUrl(newUrl)
    })
  }, [dataSource?.preview])

  // 导航到 URL
  const navigate = useCallback((targetUrl: string) => {
    if (!targetUrl.trim()) return
    const fullUrl = targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`
    setUrl(fullUrl)
    setInputUrl(fullUrl)
    dataSource?.preview?.open(fullUrl)
  }, [dataSource?.preview])

  // 刷新
  const reload = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src
    }
    dataSource?.preview?.reload()
  }, [dataSource?.preview])

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--bg-primary)',
    }}>
      {/* 地址栏 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '4px 8px',
        borderBottom: '1px solid var(--border)',
      }}>
        <button
          onClick={reload}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: '14px',
            padding: '2px',
          }}
        >
          ↻
        </button>
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate(inputUrl)
          }}
          placeholder="输入 URL..."
          style={{
            flex: 1,
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '4px 8px',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--text-primary)',
            outline: 'none',
          }}
        />
      </div>

      {/* iframe 预览 */}
      {url ? (
        <iframe
          ref={iframeRef}
          src={url}
          style={{
            flex: 1,
            border: 'none',
            background: '#fff',
          }}
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      ) : (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-secondary)',
          fontSize: 'var(--font-size-sm)',
        }}>
          输入 URL 开始预览
        </div>
      )}
    </div>
  )
}
