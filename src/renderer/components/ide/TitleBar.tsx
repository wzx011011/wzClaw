import React, { useState, useRef, useEffect } from 'react'

type ThemeMode = 'midnight' | 'dark' | 'light'

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: 'midnight', label: 'Midnight' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
]

interface TitleBarProps {
  onOpenFolder: () => void
  onToggleTerminal: () => void
  onToggleRightSidebar: () => void
  rightSidebarVisible: boolean
  onConnectPhone: () => void
  onOpenBrowser: () => void
  onBackToTasks?: () => void
  activeTaskTitle?: string
}

/**
 * TitleBar — custom draggable titlebar for frameless window.
 * Works with Electron's titleBarStyle: 'hidden' + titleBarOverlay.
 * The native window controls (minimize/maximize/close) are rendered
 * by the OS overlay on the right side.
 */
export default function TitleBar({
  onOpenFolder,
  onToggleTerminal,
  onToggleRightSidebar,
  rightSidebarVisible,
  onConnectPhone,
  onOpenBrowser,
  onBackToTasks,
  activeTaskTitle
}: TitleBarProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [currentTheme, setCurrentTheme] = useState<ThemeMode>('midnight')
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const applyTheme = (theme: ThemeMode) => {
    setCurrentTheme(theme)
    setMenuOpen(false)
    const root = document.documentElement
    if (theme === 'midnight') {
      root.setAttribute('data-theme', 'midnight')
    } else if (theme === 'dark') {
      root.setAttribute('data-theme', 'dark')
    } else {
      root.setAttribute('data-theme', 'light')
    }
    // Update native window control button colors to match theme
    const overlayColors = theme === 'light'
      ? { color: '#f5f5f5', symbolColor: '#333333' }
      : { color: '#181818', symbolColor: '#e0e0e0' }
    window.wzxclaw.setTitleBarOverlay?.(overlayColors)
  }

  return (
    <div className="ide-titlebar">
      {/* Back to tasks */}
      {onBackToTasks && (
        <button className="task-back-btn" onClick={onBackToTasks} title="返回任务列表">
          ← {activeTaskTitle || '任务'}
        </button>
      )}

      {/* Hamburger menu */}
      <div className="titlebar-menu-container" ref={menuRef}>
        <button
          className={`titlebar-action-btn titlebar-hamburger${menuOpen ? ' active' : ''}`}
          title="菜单"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        {menuOpen && (
          <div className="titlebar-dropdown-menu">
            <button className="titlebar-menu-item" onClick={() => { onOpenFolder(); setMenuOpen(false) }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
              打开文件夹
            </button>
            <div className="titlebar-menu-separator" />
            <div className="titlebar-menu-label">主题</div>
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`titlebar-menu-item${currentTheme === t.id ? ' selected' : ''}`}
                onClick={() => applyTheme(t.id)}
              >
                {currentTheme === t.id && <span className="titlebar-menu-check">✓</span>}
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="ide-titlebar-brand">wzxClaw</span>

      <div className="ide-titlebar-actions">
        {/* Folder — open workspace folder */}
        <button
          className="titlebar-action-btn"
          title="打开文件夹 (Ctrl+Shift+O)"
          onClick={onOpenFolder}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </button>

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
