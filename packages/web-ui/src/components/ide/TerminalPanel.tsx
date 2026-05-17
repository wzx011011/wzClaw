// ============================================================
// TerminalPanel — xterm.js 终端面板
//
// 懒加载 xterm，创建终端实例并连接 DataSource.terminal 通道。
// 支持多终端标签（TerminalTabs）。
// ============================================================

import React, { useEffect, useRef, useCallback } from 'react'
import { useDataSource } from '../../providers/DataSourceProvider'
import { useTerminalStore, generateTerminalId } from '../../stores/terminal-store'
import TerminalTabs from './TerminalTabs'

export default function TerminalPanel(): React.ReactElement {
  const dataSource = useDataSource()
  const terminals = useTerminalStore((s) => s.terminals)
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId)
  const addTerminal = useTerminalStore((s) => s.addTerminal)
  const panelVisible = useTerminalStore((s) => s.panelVisible)

  /** terminalId → Terminal 实例映射 */
  const terminalInstances = useRef<Map<string, any>>(new Map())
  /** terminalId → div 容器映射 */
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  /** terminalId → fitAddon 实例映射 */
  const fitAddons = useRef<Map<string, any>>(new Map())
  /** 是否已初始化 */
  const initialized = useRef(false)

  // 创建第一个终端
  useEffect(() => {
    if (initialized.current || !dataSource?.terminal) return
    initialized.current = true
    spawnTerminal()
  }, [dataSource?.terminal])

  // 当 activeTerminalId 变化时，显示/隐藏终端容器
  useEffect(() => {
    for (const [id, container] of containerRefs.current) {
      container.style.display = id === activeTerminalId ? 'block' : 'none'
    }
    // 触发 fit
    if (activeTerminalId) {
      const addon = fitAddons.current.get(activeTerminalId)
      if (addon) {
        setTimeout(() => addon.fit(), 0)
      }
    }
  }, [activeTerminalId])

  // 生成新终端
  const spawnTerminal = useCallback(async () => {
    if (!dataSource?.terminal) return

    const id = generateTerminalId()
    addTerminal(id, `终端 ${useTerminalStore.getState().terminals.length + 1}`)

    // 等待渲染容器
    await new Promise((resolve) => setTimeout(resolve, 50))

    const container = containerRefs.current.get(id)
    if (!container) return

    // 懒加载 xterm
    const { Terminal } = await import('@xterm/xterm')
    const { FitAddon } = await import('@xterm/addon-fit')
    await import('@xterm/addon-web-links')

    const term = new Terminal({
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
      },
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace",
      cursorBlink: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()

    terminalInstances.current.set(id, term)
    fitAddons.current.set(id, fitAddon)

    // 通过 DataSource.terminal 通道 spawn
    try {
      await dataSource.terminal.spawn({ cols: term.cols, rows: term.rows })
    } catch (err) {
      term.writeln(`\x1b[31m连接失败: ${err}\x1b[0m`)
    }

    // 用户输入 → terminal.write
    term.onData((data: string) => {
      dataSource.terminal?.write(id, data)
    })

    // 通道数据 → term.write
    dataSource.terminal.onData(id, (data: string) => {
      term.write(data)
    })

    // 终端退出
    dataSource.terminal.onExit(id, (exitCode: number) => {
      term.writeln(`\r\n\x1b[33m进程退出 (code: ${exitCode})\x1b[0m`)
    })

    // 窗口大小变化
    const resizeObserver = new ResizeObserver(() => {
      try { fitAddon.fit() } catch { /* ignore */ }
    })
    resizeObserver.observe(container)
  }, [dataSource?.terminal, addTerminal])

  if (!dataSource?.terminal) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--text-secondary)',
        fontSize: 'var(--font-size-sm)',
      }}>
        终端不可用（当前连接不支持终端）
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#1e1e1e',
    }}>
      <TerminalTabs />
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {terminals.map((term) => (
          <div
            key={term.id}
            ref={(el) => {
              if (el) containerRefs.current.set(term.id, el)
            }}
            style={{
              position: 'absolute',
              inset: 0,
              display: term.id === activeTerminalId ? 'block' : 'none',
            }}
          />
        ))}
      </div>
      {/* 新建终端按钮 */}
      <div style={{
        padding: '4px 8px',
        borderTop: '1px solid var(--border)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}>
        <button
          onClick={spawnTerminal}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            color: 'var(--text-secondary)',
            fontSize: 'var(--font-size-xs)',
            padding: '2px 8px',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
          }}
        >
          + 新终端
        </button>
      </div>
    </div>
  )
}
