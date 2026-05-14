import { useState, useEffect } from 'react'

/**
 * App 壳组件
 *
 * 最小可运行壳 — 渲染标题 + 连接状态指示器。
 * 后续 plan 会逐步添加聊天面板、会话管理等组件。
 */
function App() {
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    // 后续接入 DataSource 后，这里会监听连接状态变化
    // 目前仅作为占位
    setConnected(false)
  }, [])

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>wzxClaw Web UI</h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '1rem' }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            backgroundColor: connected ? '#4caf50' : '#f44336',
            display: 'inline-block',
          }}
        />
        <span>{connected ? '已连接' : '未连接'}</span>
      </div>
    </div>
  )
}

export default App
