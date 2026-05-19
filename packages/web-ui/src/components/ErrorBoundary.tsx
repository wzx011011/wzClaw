// ============================================================
// ErrorBoundary — React 错误边界
//
// 捕获子组件树渲染错误，防止整个应用崩溃。
// 显示友好的错误 UI + 重置按钮。
// ============================================================

import React from 'react'

interface Props {
  children: React.ReactNode
  /** 自定义回退 UI（可选） */
  fallback?: React.ReactNode
  /** 错误发生时的回调 */
  onError?: (error: Error, info: React.ErrorInfo) => void
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info)
    this.props.onError?.(error, info)
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children

    if (this.props.fallback) return this.props.fallback

    const { error } = this.state
    return (
      <div style={{
        padding: 'var(--sp-6, 24px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--sp-3, 12px)',
        color: 'var(--text-primary, #e0e0e0)',
        background: 'var(--bg-primary, #1a1a2e)',
        minHeight: '200px',
        textAlign: 'center',
      }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--tool-error, #ef4444)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div style={{ fontSize: 'var(--font-size-lg, 16px)', fontWeight: 600 }}>
          出了点问题
        </div>
        {error && (
          <div style={{
            fontSize: 'var(--font-size-sm, 12px)',
            color: 'var(--text-secondary, #888)',
            maxWidth: '400px',
            fontFamily: 'monospace',
            padding: '8px 12px',
            background: 'var(--bg-secondary, #2a2a3e)',
            borderRadius: 'var(--radius-sm, 4px)',
            wordBreak: 'break-all',
          }}>
            {error.message}
          </div>
        )}
        <button
          onClick={this.handleReset}
          style={{
            padding: '6px 16px',
            background: 'var(--accent, #7b6ef6)',
            color: '#fff',
            border: 'none',
            borderRadius: 'var(--radius-sm, 4px)',
            cursor: 'pointer',
            fontSize: 'var(--font-size-sm, 12px)',
          }}
        >
          重试
        </button>
      </div>
    )
  }
}

export default ErrorBoundary
