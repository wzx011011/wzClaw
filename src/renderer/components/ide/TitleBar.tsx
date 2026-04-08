import React from 'react'

interface TitleBarProps {
  onToggleTerminal: () => void
  onToggleRightSidebar: () => void
  rightSidebarVisible: boolean
  onConnectPhone: () => void
  onOpenBrowser: () => void
}

/**
 * TitleBar — custom draggable titlebar for frameless window.
 * Works with Electron's titleBarStyle: 'hidden' + titleBarOverlay.
 * The native window controls (minimize/maximize/close) are rendered
 * by the OS overlay on the right side.
 *
 * Action buttons (no-drag):
 *   Smartphone — connect mobile device
 *   Terminal   — toggle bottom terminal panel
 *   Globe      — open browser / AI preview in right sidebar
 *   Layout     — toggle right sidebar visibility
 */
export default function TitleBar({
  onToggleTerminal,
  onToggleRightSidebar,
  rightSidebarVisible,
  onConnectPhone,
  onOpenBrowser
}: TitleBarProps): JSX.Element {
  return (
    <div className="ide-titlebar">
      <span className="ide-titlebar-brand">wzxClaw</span>

      <div className="ide-titlebar-actions">
        {/* Smartphone — connect phone */}
        <button
          className="titlebar-action-btn"
          title="连接手机"
          onClick={onConnectPhone}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <line x1="12" y1="18" x2="12.01" y2="18" />
          </svg>
        </button>

        {/* Terminal — toggle terminal panel */}
        <button
          className="titlebar-action-btn"
          title="显示终端 (Ctrl+`)"
          onClick={onToggleTerminal}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </button>

        {/* Globe — open browser / AI preview */}
        <button
          className="titlebar-action-btn"
          title="打开浏览器"
          onClick={onOpenBrowser}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z" />
          </svg>
        </button>

        {/* Layout — toggle right sidebar */}
        <button
          className={`titlebar-action-btn${rightSidebarVisible ? ' active' : ''}`}
          title="切换右侧边栏 (Ctrl+Shift+B)"
          onClick={onToggleRightSidebar}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
        </button>
      </div>
    </div>
  )
}
