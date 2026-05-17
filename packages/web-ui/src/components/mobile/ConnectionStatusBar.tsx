// ============================================================
// ConnectionStatusBar — 连接状态浮动指示
//
// 连接状态变化时短暂显示（已连接 2s / 断开持续 / 重连 2s）。
// 固定在 TopBar 下方，z-index 40。
// ============================================================

import React, { useState, useEffect, useRef } from 'react'
import { useConnectionState } from '../../providers/DataSourceProvider'

type Status = 'connected' | 'disconnected' | 'reconnected'

export default function ConnectionStatusBar(): React.ReactElement | null {
  const connected = useConnectionState()
  const prevConnected = useRef(connected)
  const [visible, setVisible] = useState(false)
  const [status, setStatus] = useState<Status>('disconnected')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (prevConnected.current === connected) return

    if (connected) {
      setStatus(prevConnected.current === false ? 'reconnected' : 'connected')
      setVisible(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setVisible(false), 2000)
    } else {
      setStatus('disconnected')
      setVisible(true)
    }
    prevConnected.current = connected

    return () => clearTimeout(timer.current)
  }, [connected])

  if (!visible) return null

  const isOk = status === 'connected' || status === 'reconnected'
  const text = status === 'connected' ? '已连接'
    : status === 'reconnected' ? '已重连'
    : '连接断开，正在重连...'

  return (
    <div
      className="connection-status-bar"
      style={{
        background: isOk ? 'var(--tool-completed)' : 'var(--tool-error)',
      }}
    >
      <span style={{ fontSize: 'var(--font-size-xs)', color: '#fff' }}>{text}</span>
    </div>
  )
}
