import { lazy, Suspense, useEffect } from 'react'
import TaskHomePage from './components/tasks/TaskHomePage'
import ErrorBoundary from './components/ErrorBoundary'
import Toast from './components/Toast'
import { useTaskStore } from './stores/task-store'
import { useSettingsStore } from './stores/settings-store'
import './styles/ide.css'
import './styles/chat.css'
import './styles/tasks.css'
import 'highlight.js/styles/vs2015.css'

// 懒加载：IDELayout 拉入 monaco/xterm/allotment 等重量级模块；TaskDetailPage 也按需加载
const IDELayout = lazy(() => import('./components/ide/IDELayout'))
const TaskDetailPage = lazy(() => import('./components/tasks/TaskDetailPage'))

function App(): JSX.Element {
  const activeTaskId = useTaskStore((s) => s.activeTaskId)
  const viewingTaskId = useTaskStore((s) => s.viewingTaskId)
  const loadSettings = useSettingsStore((s) => s.loadSettings)

  // 启动时从主进程加载已保存的设置，确保 store 不停留在默认值
  useEffect(() => {
    loadSettings()
  }, [])

  if (activeTaskId) return (
    <ErrorBoundary scope="IDELayout">
      <Suspense fallback={<div style={{ background: 'var(--bg-primary)', height: '100vh' }} />}>
        <IDELayout />
      </Suspense>
      <Toast />
    </ErrorBoundary>
  )
  if (viewingTaskId) return (
    <ErrorBoundary scope="TaskDetailPage">
      <Suspense fallback={<div style={{ background: 'var(--bg-primary)', height: '100vh' }} />}>
        <TaskDetailPage />
      </Suspense>
      <Toast />
    </ErrorBoundary>
  )
  return (
    <ErrorBoundary scope="TaskHomePage">
      <TaskHomePage />
      <Toast />
    </ErrorBoundary>
  )
}

export default App
