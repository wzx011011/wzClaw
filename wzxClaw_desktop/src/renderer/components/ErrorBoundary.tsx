import React from 'react'
import { useI18nStore } from '../i18n/i18n-store'

interface ErrorBoundaryProps {
  /** Optional name shown in the fallback UI. */
  scope?: string
  children: React.ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
  info: React.ErrorInfo | null
}

/**
 * Catches render-time errors in descendant React components and shows a
 * graceful fallback instead of a blank white page. Wrap the app shell
 * (IDELayout, WorkspaceDetailPage…) so a single buggy subtree doesn't kill the UI.
 */
export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, info: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, info: null }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ info })
    // 主进程已经在监听 console.error；这里直接抛出给开发者排查
    console.error('[ErrorBoundary] Caught render error:', error, info)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  private handleReset = (): void => {
    this.setState({ error: null, info: null })
  }

  render(): React.ReactNode {
    const { error, info } = this.state
    if (!error) return this.props.children

    const t = useI18nStore.getState().t

    return (
      <div className="error-boundary">
        <div className="error-boundary-card">
          <div className="error-boundary-icon">⚠</div>
          <h2 className="error-boundary-title">{t('errorBoundary.title')}</h2>
          <p className="error-boundary-subtitle">
            {t('errorBoundary.subtitle', { scope: this.props.scope ?? '' })}
          </p>
          <pre className="error-boundary-detail">
            {error.message}
            {info?.componentStack ? `\n${info.componentStack.split('\n').slice(0, 5).join('\n')}` : ''}
          </pre>
          <div className="error-boundary-actions">
            <button className="error-boundary-btn primary" onClick={this.handleReset}>
              {t('errorBoundary.reset')}
            </button>
            <button className="error-boundary-btn" onClick={this.handleReload}>
              {t('errorBoundary.reload')}
            </button>
          </div>
        </div>
      </div>
    )
  }
}
