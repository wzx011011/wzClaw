import { lazy, Suspense, useEffect, useLayoutEffect } from 'react'
import WorkspaceHomePage from './components/tasks/WorkspaceHomePage'
import WorkspaceDetailPage from './components/tasks/WorkspaceDetailPage'
import ErrorBoundary from './components/ErrorBoundary'
import Toast from './components/Toast'
import { useWorkspaceStore } from './stores/workspace-store'
import { useSettingsStore } from './stores/settings-store'
import { useI18nStore } from './i18n/i18n-store'
import './styles/ide.css'
import './styles/chat.css'
import './styles/workspaces.css'
import 'highlight.js/styles/vs2015.css'

// 懒加载：IDELayout 拉入 monaco/xterm/allotment 等重量级模块
const IDELayout = lazy(() => import('./components/ide/IDELayout'))

function App(): JSX.Element {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const viewingWorkspaceId = useWorkspaceStore((s) => s.viewingWorkspaceId)
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const initLocale = useI18nStore((s) => s.initLocale)

  // 启动时从主进程加载已保存的设置，确保 store 不停留在默认值
  useEffect(() => {
    loadSettings().then(() => {
      const language = useSettingsStore.getState().language
      initLocale(language)
    })
  }, [])

    // splash drag div 保留不删除 — 它提供永久的窗口拖拽区域（pointer-events:none 不影响交互）
    // 页面切换时组件级 dragbar 可能无法被 Chromium hit-test 缓存识别，splash div 确保始终可拖

  if (activeWorkspaceId) return (
    <ErrorBoundary scope="IDELayout">
      <Suspense fallback={<div style={{ background: 'var(--bg-primary)', height: '100vh' }} />}>
        <IDELayout />
      </Suspense>
      <Toast />
    </ErrorBoundary>
  )
  if (viewingWorkspaceId) return (
    <ErrorBoundary scope="WorkspaceDetailPage">
      <WorkspaceDetailPage />
      <Toast />
    </ErrorBoundary>
  )
  return (
    <ErrorBoundary scope="WorkspaceHomePage">
      <WorkspaceHomePage />
      <Toast />
    </ErrorBoundary>
  )
}

export default App
