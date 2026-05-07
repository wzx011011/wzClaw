import React, { useEffect, useRef, useState } from 'react'
import { useTerminalStore } from '../../stores/terminal-store'
import TerminalTabs from './TerminalTabs'

// ============================================================
// TerminalPanel — xterm.js terminal rendering with PTY connection
// (per TERM-01, TERM-02, TERM-05)
//
// Manages a Map of xterm Terminal instances, one per terminal tab.
// Connects xterm input to PTY via IPC and subscribes to PTY output.
// Uses FitAddon for auto-resize and WebLinksAddon for clickable URLs.
// ============================================================

// Lazily load xterm modules (they are renderer-side only)
// Use minimal interfaces to avoid importing xterm at module level
interface XtermTerminal {
  open(container: HTMLElement): void
  dispose(): void
  onData(callback: (data: string) => void): { dispose(): void }
  loadAddon(addon: { dispose?(): void }): void
  write(data: string): void
  readonly cols: number
  readonly rows: number
}
interface XtermFitAddon {
  fit(): void
}
interface XtermWebLinksAddon {
  dispose?(): void
}

// Cached module references after dynamic import
let CachedTerminal: (new (options: Record<string, unknown>) => XtermTerminal) | null = null
let CachedFitAddon: (new () => XtermFitAddon) | null = null
let CachedWebLinksAddon: (new () => XtermWebLinksAddon) | null = null

// 根据当前主题返回 xterm 配色
function getXtermTheme(): Record<string, string> {
  const theme = document.documentElement.getAttribute('data-theme') || 'midnight'
  if (theme === 'light') {
    return {
      background: '#ffffff',
      foreground: '#383a42',
      cursor: '#526eff',
      cursorAccent: '#ffffff',
      selectionBackground: '#add6ff',
      black: '#383a42',
      red: '#e45649',
      green: '#50a14f',
      yellow: '#c18401',
      blue: '#4078f2',
      magenta: '#a626a4',
      cyan: '#0184bc',
      white: '#a0a1a7',
      brightBlack: '#4f525e',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff'
    }
  }
  // midnight / dark 共用深色配色
  return {
    background: '#1e1e1e',
    foreground: '#cccccc',
    cursor: '#007acc',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#ffffff'
  }
}

/**
 * Dynamically import xterm and its addons.
 * Returns module references or null if loading failed.
 * Uses Vite-compatible dynamic import() instead of require().
 */
async function loadXtermModules(): Promise<{
  Terminal: (new (options: Record<string, unknown>) => XtermTerminal)
  FitAddon: (new () => XtermFitAddon)
  WebLinksAddon: (new () => XtermWebLinksAddon)
} | null> {
  // Return cached modules if already loaded
  if (CachedTerminal && CachedFitAddon && CachedWebLinksAddon) {
    return { Terminal: CachedTerminal, FitAddon: CachedFitAddon, WebLinksAddon: CachedWebLinksAddon }
  }
  try {
    const [xtermMod, fitMod, webLinksMod] = await Promise.all([
      import('xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links')
    ])
    // Import xterm CSS
    await import('xterm/css/xterm.css')

    CachedTerminal = xtermMod.Terminal as (new (options: Record<string, unknown>) => XtermTerminal)
    CachedFitAddon = fitMod.FitAddon as (new () => XtermFitAddon)
    CachedWebLinksAddon = webLinksMod.WebLinksAddon as (new () => XtermWebLinksAddon)

    return { Terminal: CachedTerminal, FitAddon: CachedFitAddon, WebLinksAddon: CachedWebLinksAddon }
  } catch (err) {
    console.error('Failed to load xterm modules:', err)
    return null
  }
}

export default function TerminalPanel(): JSX.Element {
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId)
  const tabs = useTerminalStore((s) => s.tabs)

  // Tracks whether xterm modules are loaded
  const [xtermReady, setXtermReady] = useState(false)
  const xtermModulesRef = useRef<{
    Terminal: (new (options: Record<string, unknown>) => XtermTerminal)
    FitAddon: (new () => XtermFitAddon)
    WebLinksAddon: (new () => XtermWebLinksAddon)
  } | null>(null)

  // Maps terminal IDs to xterm Terminal instances and FitAddon instances
  const terminalsRef = useRef<Map<string, XtermTerminal>>(new Map())
  const fitAddonsRef = useRef<Map<string, XtermFitAddon>>(new Map())
  const unsubscribersRef = useRef<Map<string, () => void>>(new Map())
  const containerRef = useRef<HTMLDivElement>(null)

  // Load xterm modules on first render
  useEffect(() => {
    let cancelled = false
    loadXtermModules().then((modules) => {
      if (cancelled || !modules) return
      xtermModulesRef.current = modules
      setXtermReady(true)
    })
    return () => { cancelled = true }
  }, [])

  // Create and manage xterm instance for active terminal
  useEffect(() => {
    if (!activeTerminalId || !xtermReady || !xtermModulesRef.current || !containerRef.current) return

    const { Terminal: TerminalCtor, FitAddon: FitAddonCtor, WebLinksAddon: WebLinksAddonCtor } = xtermModulesRef.current

    // Skip if we already have an instance for this terminal
    if (terminalsRef.current.has(activeTerminalId)) {
      // Make sure it's visible and fitted
      const existingTerm = terminalsRef.current.get(activeTerminalId)
      const existingFit = fitAddonsRef.current.get(activeTerminalId)
      if (existingTerm && existingFit) {
        // Detach from previous parent if needed and re-open in container
        try {
          existingTerm.open(containerRef.current)
          setTimeout(() => existingFit.fit(), 50)
        } catch {
          // Terminal already attached to this container
        }
      }
      return
    }

    // Create new xterm instance
    const term = new TerminalCtor({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: getXtermTheme(),
      scrollback: 1000,
      lineHeight: 1.2,
      allowTransparency: false
    })

    // Load addons
    const fitAddon = new FitAddonCtor()
    const webLinksAddon = new WebLinksAddonCtor()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)

    // Open in container
    term.open(containerRef.current)

    // Fit after opening
    setTimeout(() => {
      try {
        fitAddon.fit()
      } catch {
        // Ignore fit errors during initialization
      }
    }, 100)

    // Wire terminal input -> PTY via IPC
    const inputDataDisposable = term.onData((data: string) => {
      window.wzxclaw.terminalInput({ terminalId: activeTerminalId, data })
    })

    // Subscribe to PTY output via IPC
    const unsubData = window.wzxclaw.onTerminalData((payload) => {
      if (payload.terminalId === activeTerminalId) {
        term.write(payload.data)
      }
    })

    // Notify main process of terminal dimensions
    try {
      const { cols, rows } = term
      window.wzxclaw.terminalResize({ terminalId: activeTerminalId, cols, rows })
    } catch {
      // Ignore resize errors during init
    }

    // Store references
    terminalsRef.current.set(activeTerminalId, term)
    fitAddonsRef.current.set(activeTerminalId, fitAddon)
    unsubscribersRef.current.set(activeTerminalId, () => {
      inputDataDisposable.dispose()
      unsubData()
    })

    return () => {
      // Cleanup is handled in the separate cleanup effect below
    }
  }, [activeTerminalId, xtermReady])

  // Handle resize with ResizeObserver — 防抖 80ms，避免 Allotment 拖拽时每像素触发 IPC
  useEffect(() => {
    if (!containerRef.current) return

    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const observer = new ResizeObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        if (activeTerminalId) {
          const fitAddon = fitAddonsRef.current.get(activeTerminalId)
          if (fitAddon) {
            try {
              fitAddon.fit()
              const term = terminalsRef.current.get(activeTerminalId)
              if (term) {
                window.wzxclaw.terminalResize({
                  terminalId: activeTerminalId,
                  cols: term.cols,
                  rows: term.rows
                })
              }
            } catch {
              // Ignore fit errors during resize
            }
          }
        }
      }, 80)
    })

    observer.observe(containerRef.current)
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      observer.disconnect()
    }
  }, [activeTerminalId])

  // Cleanup terminal instances when tabs are removed
  const prevTabsLengthRef = useRef(tabs.length)
  useEffect(() => {
    const currentIds = new Set(tabs.map((t) => t.id))
    const instanceIds = Array.from(terminalsRef.current.keys())

    for (const id of instanceIds) {
      if (!currentIds.has(id)) {
        // Terminal was closed — dispose instance
        const unsub = unsubscribersRef.current.get(id)
        if (unsub) {
          unsub()
          unsubscribersRef.current.delete(id)
        }
        const term = terminalsRef.current.get(id)
        if (term) {
          term.dispose()
          terminalsRef.current.delete(id)
        }
        fitAddonsRef.current.delete(id)
      }
    }
    prevTabsLengthRef.current = tabs.length
  }, [tabs])

  // Cleanup all on unmount
  useEffect(() => {
    return () => {
      for (const [id, unsub] of unsubscribersRef.current) {
        unsub()
        const term = terminalsRef.current.get(id)
        if (term) term.dispose()
      }
      unsubscribersRef.current.clear()
      terminalsRef.current.clear()
      fitAddonsRef.current.clear()
    }
  }, [])

  return (
    <div className="terminal-panel">
      <TerminalTabs />
      <div
        ref={containerRef}
        className="terminal-container"
        role="tabpanel"
        aria-label="Terminal"
      >
        {!xtermReady && (
          <div style={{ padding: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
            Loading terminal...
          </div>
        )}
      </div>
    </div>
  )
}
