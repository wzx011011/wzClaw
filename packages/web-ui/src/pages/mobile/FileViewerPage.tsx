// ============================================================
// FileViewerPage — 手机端文件预览
//
// 支持文本/代码/图片预览，Hand 离线时显示错误提示。
// ============================================================

import React, { useState, useEffect } from 'react'
import type { FsChannel } from '../../data-source/types'

interface FileViewerPageProps {
  filePath: string
  fileName: string
  fs: FsChannel | undefined
  onBack: () => void
}

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.json', '.md', '.txt', '.css',
  '.html', '.yaml', '.yml', '.toml', '.sh', '.bash', '.env', '.log',
  '.cfg', '.ini', '.rs', '.go', '.java', '.c', '.cpp', '.h',
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'])

function getFileExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

export default function FileViewerPage({ filePath, fileName, fs, onBack }: FileViewerPageProps): React.ReactElement {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const ext = getFileExt(fileName)
  const isCode = CODE_EXTENSIONS.has(ext)
  const isImage = IMAGE_EXTENSIONS.has(ext)

  useEffect(() => {
    if (isImage || !fs) return
    setLoading(true)
    setError(null)
    fs.readFile(filePath)
      .then((result) => {
        setContent(result.content)
        setLoading(false)
      })
      .catch((err: any) => {
        const msg = err?.message || String(err)
        setError(msg.includes('Hand') || msg.includes('connect') ? 'Hand 离线，无法读取文件' : msg)
        setLoading(false)
      })
  }, [filePath, fs]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 顶部：返回 + 文件名 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        padding: 'var(--sp-2) var(--sp-3)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <button
          onClick={onBack}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            padding: '4px',
            display: 'flex',
            alignItems: 'center',
            touchAction: 'manipulation',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span style={{
          fontSize: 'var(--font-size-sm)',
          fontWeight: 600,
          color: 'var(--text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {fileName}
        </span>
      </div>

      {/* 内容区 */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {loading && !isImage && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--text-secondary)',
            gap: '8px',
          }}>
            <span className="thinking-dot" /> 加载中...
          </div>
        )}

        {error && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--text-secondary)',
            gap: 'var(--sp-2)',
            padding: 'var(--sp-4)',
            textAlign: 'center' as const,
          }}>
            <span>{error}</span>
          </div>
        )}

        {isCode && content && !error && (
          <pre style={{
            margin: 0,
            padding: 'var(--sp-3)',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            lineHeight: 1.5,
            color: 'var(--text-primary)',
            background: 'var(--bg-primary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflowX: 'auto',
            WebkitOverflowScrolling: 'touch',
          }}>
            {content}
          </pre>
        )}

        {!isCode && !isImage && content && !error && (
          <div style={{
            padding: 'var(--sp-3)',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            color: 'var(--text-primary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {content}
          </div>
        )}

        {isImage && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '200px',
            padding: 'var(--sp-3)',
          }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
              图片预览需要 Hand 支持
            </span>
          </div>
        )}

        {!isCode && !isImage && !loading && !error && !content && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--text-secondary)',
            fontSize: 'var(--font-size-sm)',
          }}>
            不支持预览此文件类型
          </div>
        )}
      </div>
    </div>
  )
}
