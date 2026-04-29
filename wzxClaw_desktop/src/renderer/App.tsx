import { lazy, Suspense, useEffect } from 'react'
import WorkspaceHomePage from './components/tasks/WorkspaceHomePage'
import ErrorBoundary from './components/ErrorBoundary'
import Toast from './components/Toast'
import { useWorkspaceStore } from './stores/workspace-store'
import { useSettingsStore } from './stores/settings-store'
import './styles/ide.css'
import './styles/chat.css'
import './styles/workspaces.css'
import 'highlight.js/styles/vs2015.css'

// 懒加载：IDELayout 拉入 monaco/xterm/allotment 等重量级模块；WorkspaceDetailPage 也按需加载
const IDELayout = lazy(() => import('./components/ide/IDELayout'))
const WorkspaceDetailPage = lazy(() => import('./components/tasks/WorkspaceDetailPage'))

function App(): JSX.Element {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const viewingWorkspaceId = useWorkspaceStore((s) => s.viewingWorkspaceId)
  const loadSettings = useSettingsStore((s) => s.loadSettings)

  // 启动时从主进程加载已保存的设置，确保 store 不停留在默认值
  useEffect(() => {
    loadSettings()
  }, [])

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
      <Suspense fallback={<div style={{ background: 'var(--bg-primary)', height: '100vh' }} />}>
        <WorkspaceDetailPage />
      </Suspense>
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
