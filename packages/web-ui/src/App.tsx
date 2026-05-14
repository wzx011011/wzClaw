// ============================================================
// App 壳组件 — 组合 DataSource + SessionList + ChatPanel + SettingsPage
// ============================================================

import { useState, useEffect, useRef } from 'react'
import { createDataSource } from './data-source'
import type { DataSource } from './data-source/types'
import { createChatStore } from './stores/chat-store'
import ChatPanel from './components/chat/ChatPanel'
import SessionList from './components/chat/SessionList'
import SettingsPage from './components/settings/SettingsPage'
import './styles/chat.css'
import './styles/settings.css'

/** App 视图状态 */
type AppView = 'chat' | 'settings'

function App() {
  const [connected, setConnected] = useState(false)
  const [modelName, setModelName] = useState<string>('')
  const [view, setView] = useState<AppView>('chat')
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

  const store = storeRef.current

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {view === 'settings' ? (
        <SettingsPage
          onClose={() => setView('chat')}
          onConnectionChange={(c) => setConnected(c)}
        />
      ) : (
        <div style={{ display: 'flex', height: '100%' }}>
          {/* 左侧：会话列表 */}
          <div style={{ width: '260px', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
            <SessionList store={store} />
            {/* 底部：新建会话 + 设置按钮 */}
            <div style={{
              display: 'flex',
              gap: '8px',
              padding: '8px 12px',
              borderTop: '1px solid var(--border-subtle)',
              flexShrink: 0,
            }}>
              <button
                className="session-confirm-btn"
                style={{ flex: 1, fontSize: '12px', padding: '6px' }}
                onClick={() => store.getState().createSession()}
                title="新建会话"
              >
                + 新建会话
              </button>
              <button
                className="session-confirm-btn"
                style={{ padding: '6px 10px' }}
                onClick={() => setView('settings')}
                title="设置"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            </div>
          </div>

          {/* 右侧：聊天面板 */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <ChatPanel
              store={store}
              connected={connected}
              modelName={modelName}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default App
