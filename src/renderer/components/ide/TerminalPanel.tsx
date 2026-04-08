import React, { useEffect, useRef, useCallback } from 'react'
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
let Terminal: any = null
let FitAddon: any = null
let WebLinksAddon: any = null
let xtermLoaded = false

function loadXtermModules(): void {
  if (xtermLoaded) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Terminal = require('xterm').Terminal
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    FitAddon = require('@xterm/addon-fit').FitAddon
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    WebLinksAddon = require('@xterm/addon-web-links').WebLinksAddon
    // Load xterm CSS
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('xterm/css/xterm.css')
    xtermLoaded = true
  } catch (err) {
    console.error('Failed to load xterm modules:', err)
  }
}

export default function TerminalPanel(): JSX.Element {
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId)
  const tabs = useTerminalStore((s) => s.tabs)

  // Maps terminal IDs to xterm Terminal instances and FitAddon instances
  const terminalsRef = useRef<Map<string, any>>(new Map())
  const fitAddonsRef = useRef<Map<string, any>>(new Map())
  const unsubscribersRef = useRef<Map<string, () => void>>(new Map())
  const containerRef = useRef<HTMLDivElement>(null)

  // Load xterm modules on first render
  useEffect(() => {
    loadXtermModules()
  }, [])

  // Create and manage xterm instance for active terminal
  useEffect(() => {
    if (!activeTerminalId || !Terminal || !containerRef.current) return

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
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: {
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
      },
      scrollback: 1000,
      lineHeight: 1.2,
      allowTransparency: false
    })

    // Load addons
    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
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
  }, [activeTerminalId])

  // Handle resize with ResizeObserver
  useEffect(() => {
    if (!containerRef.current) return

    const observer = new ResizeObserver(() => {
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
    })

    observer.observe(containerRef.current)
    return () => observer.disconnect()
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
      />
    </div>
  )
}
