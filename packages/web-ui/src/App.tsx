// ============================================================
// App 壳组件 — 组合 DataSource + ChatPanel
// ============================================================

import { useState, useEffect, useRef } from 'react'
import { createDataSource } from './data-source'
import type { DataSource } from './data-source/types'
import { createChatStore } from './stores/chat-store'
import ChatPanel from './components/chat/ChatPanel'
import './styles/chat.css'

function App() {
  const [connected, setConnected] = useState(false)
  const [modelName, setModelName] = useState<string>('')
  const dataSourceRef = useRef<DataSource | null>(null)
  const storeRef = useRef<ReturnType<typeof createChatStore> | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    // 创建 DataSource 实例
    const ds = createDataSource()
    dataSourceRef.current = ds

    // 创建 Chat store
    const store = createChatStore(ds)
    storeRef.current = store

    // 订阅连接状态
    const unsubConn = ds.onConnectionChange((isConnected) => {
      setConnected(isConnected)
    })

    // 初始化 store（订阅 stream 事件）
    const unsubInit = store.getState().init()
    unsubRef.current = () => {
      unsubInit()
      unsubConn()
    }

    // 尝试连接（WebSocket 模式会自动连接，IPC 模式直接 resolve）
    ds.connect().then(() => {
      setConnected(true)
      // 获取设置中的模型名称
      ds.getSettings().then((settings) => {
        if (settings.model) {
          setModelName(settings.model)
        }
      }).catch(() => {})
    }).catch(() => {
      // 连接失败，状态已通过 onConnectionChange 更新
    })

    return () => {
      unsubRef.current?.()
      ds.disconnect()
    }
  }, [])

  if (!storeRef.current) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: 'var(--bg-primary)',
        color: 'var(--text-secondary)',
      }}>
        加载中...
      </div>
    )
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ChatPanel
        store={storeRef.current}
        connected={connected}
        modelName={modelName}
      />
    </div>
  )
}

export default App
