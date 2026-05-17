// ============================================================
// App 壳组件 — 应用主入口
//
// 组合：
// - DataSourceProvider（包裹整个应用，提供 DataSource 实例）
// - 顶部导航栏（logo + 连接状态 + 设置按钮）
// - 左侧 SessionList（可折叠）
// - 右侧 ChatPanel
// - SettingsPage 作为覆盖层
//
// 响应式布局：
// - 桌面端：侧边栏 + 聊天面板
// - 移动端（<=768px）：全屏聊天 + 侧边栏覆盖层（JS 控制）
// ============================================================

import { useState, useEffect, useRef, useCallback } from 'react'
import type { StoreApi } from 'zustand'
import { createChatStore } from './stores/chat-store'
import type { ChatStore } from './stores/chat-store'
import { DataSourceProvider, useDataSource, useConnectionState, useReconnect } from './providers/DataSourceProvider'
import ChatPanel from './components/chat/ChatPanel'
import SessionList from './components/chat/SessionList'
import SettingsPage from './components/settings/SettingsPage'
import IDELayout from './components/ide/IDELayout'
import MobileShell from './layouts/MobileShell'
import { useCapabilities } from './hooks/useCapabilities'
import { useI18nStore } from './i18n/i18n-store'
import { useT } from './i18n/useT'
import { useConnectionConfig } from './hooks/useConnectionConfig'
import './styles/global.css'
import './styles/chat.css'
import './styles/settings.css'
import './styles/ide.css'

/** App 视图状态 */
type AppView = 'chat' | 'ide' | 'settings'

/**
 * AppInner — 应用内部组件
 *
 * 在 DataSourceProvider 内部渲染，可以使用 useDataSource 等 hook
 */
function AppInner(): React.ReactElement {
  const t = useT()
  const connected = useConnectionState()
  const dataSource = useDataSource()
  const reconnect = useReconnect()
  const { config } = useConnectionConfig()
  const caps = useCapabilities(dataSource)

  const [view, setView] = useState<AppView>('chat')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [store, setStore] = useState<StoreApi<ChatStore> | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)

  // 当 DataSource 变化时，创建新的 chat store
  useEffect(() => {
    if (!dataSource) return

    // 清理旧 store
    if (unsubRef.current) {
      unsubRef.current()
      unsubRef.current = null
    }

    // 创建新 store
    const newStore = createChatStore(dataSource)
    setStore(() => newStore)

    // 初始化 store（订阅 stream 事件）
    const unsub = newStore.getState().init()
    unsubRef.current = unsub

    // 加载会话列表
    newStore.getState().loadSessionList()

    return () => {
      unsub()
    }
  }, [dataSource])

  // 连接状态指示器样式
  const statusColor = connected ? '#4caf50' : '#f44336'
  const statusText = connected ? t('chat.connected') : t('chat.disconnected')

  // 处理设置保存后重连
  const handleSettingsSaved = useCallback(() => {
    setView('chat')
    // 如果 URL 或 token 变了，触发重连
    reconnect(config.agentUrl, config.token || undefined)
  }, [reconnect, config.agentUrl, config.token])

  // 加载中状态
  if (!store || !dataSource) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: 'var(--bg-primary)',
        color: 'var(--text-secondary)',
        gap: '8px',
      }}>
        <span className="thinking-dot" />
        <span>{t('common.loading')}</span>
      </div>
    )
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {view === 'settings' ? (
        <SettingsPage
          onClose={handleSettingsSaved}
          onConnectionChange={() => {}}
        />
      ) : view === 'ide' && store ? (
        <IDELayout chatStore={store} connected={connected} />
      ) : caps.mobileShell && store ? (
        <MobileShell chatStore={store} connected={connected} setView={setView} dataSource={dataSource} />
      ) : (
        <>
          {/* 顶部导航栏 */}
          <nav style={{
            height: 'var(--navbar-height)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 var(--sp-3)',
            background: 'var(--bg-primary)',
            borderBottom: '1px solid var(--border)',
          }}>
            {/* 左侧：logo + 侧边栏切换 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                title={t('nav.toggleSidebar')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: 'var(--radius-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  transition: 'color var(--transition-fast)',
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
              <span style={{
                fontSize: 'var(--font-size-md)',
                fontWeight: 600,
                color: 'var(--text-primary)',
                letterSpacing: '0.02em',
              }}>
                {t('chat.title')}
              </span>
            </div>

            {/* 右侧：连接状态 + IDE切换 + 设置按钮 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {/* 连接状态指示灯 */}
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--text-secondary)',
                }}
              >
                <span style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: statusColor,
                  display: 'inline-block',
                  transition: 'background-color var(--transition-fast)',
                }} />
                {statusText}
              </span>

              {/* IDE 模式切换按钮 */}
              {(caps.localEditor || caps.terminal || caps.fileExplorer) && (
                <button
                  onClick={() => setView('ide')}
                  title="IDE 模式"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    padding: '4px',
                    borderRadius: 'var(--radius-sm)',
                    display: 'flex',
                    alignItems: 'center',
                    transition: 'color var(--transition-fast)',
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                </button>
              )}

              {/* 设置齿轮按钮 */}
              <button
                onClick={() => setView('settings')}
                title={t('nav.settings')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: 'var(--radius-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  transition: 'color var(--transition-fast)',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            </div>
          </nav>

          {/* 主体区域 */}
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            {/* 桌面端侧边栏 — 内嵌模式 */}
            {!sidebarCollapsed && (
              <div style={{
                width: 'var(--sidebar-width)',
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                borderRight: '1px solid var(--border)',
              }}>
                <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                  <SessionList store={store} />
                </div>
                {/* 底部：新建会话按钮 */}
                <div style={{
                  display: 'flex',
                  gap: 'var(--sp-2)',
                  padding: 'var(--sp-2) var(--sp-3)',
                  borderTop: '1px solid var(--border-subtle)',
                  flexShrink: 0,
                }}>
                  <button
                    className="session-confirm-btn"
                    style={{ flex: 1, fontSize: 'var(--font-size-xs)', padding: '6px' }}
                    onClick={() => store.getState().createSession()}
                    title={t('chat.newSession')}
                  >
                    {t('session.newSession')}
                  </button>
                </div>
              </div>
            )}

            {/* 右侧：聊天面板 */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <ChatPanel
                store={store}
                connected={connected}
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * App — 根组件
 *
 * 职责：
 * 1. 初始化 i18n
 * 2. DataSourceProvider 包裹整个应用
 * 3. 渲染 AppInner
 */
function App(): React.ReactElement {
  // 初始化 i18n（从 localStorage 恢复语言设置）
  const initLocale = useI18nStore((s) => s.initLocale)
  const { config } = useConnectionConfig()

  useEffect(() => {
    initLocale(config.language)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <DataSourceProvider
      initialUrl={config.agentUrl}
      initialToken={config.token || undefined}
    >
      <AppInner />
    </DataSourceProvider>
  )
}

export default App
