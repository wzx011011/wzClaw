import React, { useEffect, useState, useRef } from 'react'
import { useToastStore } from '../../stores/toast-store'
import { useT } from '../../i18n/useT'

interface BrowserState {
  running: boolean
  url: string | null
  screenshot: string | null
}

/**
 * PreviewPanel — right sidebar content.
 * Shows live browser screenshots when the agent uses browser tools,
 * or a "New Tab" empty state when no browser is active.
 * Users can manually navigate by typing a URL in the address bar.
 */
export default function PreviewPanel(): JSX.Element {
  const t = useT()
  const [browser, setBrowser] = useState<BrowserState>({
    running: false,
    url: null,
    screenshot: null
  })
  const [urlInput, setUrlInput] = useState('')
  const [navigating, setNavigating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const unsubScreenshot = window.wzxclaw.onBrowserScreenshot((payload) => {
      setBrowser((prev) => ({
        ...prev,
        running: true,
        url: payload.url,
        screenshot: payload.base64
      }))
      setNavigating(false)
    })
    const unsubStatus = window.wzxclaw.onBrowserStatus((payload) => {
      setBrowser((prev) => ({
        ...prev,
        running: payload.running,
        url: payload.url,
        screenshot: payload.running ? prev.screenshot : null
      }))
      if (!payload.running) {
        setUrlInput('')
        setNavigating(false)
      }
    })
    return () => {
      unsubScreenshot()
      unsubStatus()
    }
  }, [])

  // On mount (or when running becomes true), request a screenshot only if the
  // browser is already active. Skips the call — and avoids a spurious BrowserWindow
  // launch — when the panel opens while no browser session is running.
  useEffect(() => {
    if (!browser.running) return
    window.wzxclaw.screenshotBrowser().catch(() => {
      useToastStore.getState().show(t('preview.screenshotFailed'), 'error')
    })
  }, [browser.running])

  // Sync URL input with browser URL when it changes
  useEffect(() => {
    if (browser.url && !navigating) {
      setUrlInput(browser.url)
    }
  }, [browser.url, navigating])

  const handleNavigate = async (url: string) => {
    if (!url.trim()) return
    // Auto-add protocol if missing
    let fullUrl = url.trim()
    if (!/^https?:\/\//i.test(fullUrl)) {
      fullUrl = 'https://' + fullUrl
    }
    setNavigating(true)
    setUrlInput(fullUrl)
    setError(null)
    try {
      await window.wzxclaw.navigateBrowser(fullUrl)
      // After navigate returns, take a screenshot to update the panel
      try {
        await window.wzxclaw.screenshotBrowser()
      } catch {
        // screenshot may already be sent via event
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // Provide user-friendly error messages
      if (msg.includes('Executable doesn\'t exist') || msg.includes('browserType.launch')) {
        setError(t('preview.chromeNotFound'))
      } else if (msg.includes('net::ERR_')) {
        setError(t('preview.networkError', { error: msg.replace(/.*net::(ERR_[A-Z_]+).*/, '$1') }))
      } else {
        setError(t('preview.navigateFailed', { error: msg.length > 120 ? msg.slice(0, 120) + '…' : msg }))
      }
      setNavigating(false)
    }
  }

  const handleClose = async () => {
    await window.wzxclaw.closeBrowser()
  }

  const handleRefresh = async () => {
    if (browser.url) {
      await handleNavigate(browser.url)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleNavigate(urlInput)
    }
  }

  // Active browser state — show URL bar + screenshot
  if (browser.running && browser.screenshot) {
    return (
      <div className="preview-panel">
        <div className="preview-browser-bar">
          <div className="preview-bar-dots">
            <button className="preview-browser-dot red" title={t('preview.closeBrowser')} onClick={handleClose} />
            <div className="preview-browser-dot yellow" />
            <button className="preview-browser-dot green" title={t('preview.refresh')} onClick={handleRefresh} />
          </div>
          <input
            className="preview-url-input"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('preview.urlPlaceholder')}
            spellCheck={false}
          />
        </div>
        <div className="preview-browser-viewport">
          <img
            src={`data:image/jpeg;base64,${browser.screenshot}`}
            alt={t('preview.screenshotAlt')}
            className="preview-browser-img"
          />
          {error && <div className="preview-error">{error}</div>}
        </div>
      </div>
    )
  }

  // Empty state — show URL input for manual navigation
  return (
    <div className="preview-panel">
      <div className="preview-panel-empty">
        <div className="preview-panel-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </div>
        <h3 className="preview-panel-title">{t('preview.newTab')}</h3>
        <p className="preview-panel-desc">{t('preview.newTabDesc')}</p>
        <div className="preview-url-bar-empty">
          <input
            ref={inputRef}
            className="preview-url-input-empty"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('preview.urlInputPlaceholder')}
            spellCheck={false}
            autoFocus
          />
          <button
            className="preview-go-btn"
            onClick={() => handleNavigate(urlInput)}
            disabled={!urlInput.trim() || navigating}
          >
{navigating ? '…' : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>}
          </button>
        </div>
        {error && <div className="preview-error">{error}</div>}
      </div>
    </div>
  )
}
