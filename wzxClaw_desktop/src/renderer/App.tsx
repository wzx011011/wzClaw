import { useEffect } from 'react'
import IDELayout from './components/ide/IDELayout'
import TaskHomePage from './components/tasks/TaskHomePage'
import TaskDetailPage from './components/tasks/TaskDetailPage'
import { useTaskStore } from './stores/task-store'
import { useSettingsStore } from './stores/settings-store'
import './styles/ide.css'
import './styles/chat.css'
import './styles/tasks.css'
import 'highlight.js/styles/vs2015.css'

function App(): JSX.Element {
  const activeTaskId = useTaskStore((s) => s.activeTaskId)
  const viewingTaskId = useTaskStore((s) => s.viewingTaskId)
  const loadSettings = useSettingsStore((s) => s.loadSettings)

  // 启动时从主进程加载已保存的设置，确保 store 不停留在默认值
  useEffect(() => {
    loadSettings()
  }, [])

  if (activeTaskId) return <IDELayout />
  if (viewingTaskId) return <TaskDetailPage />
  return <TaskHomePage />
}

export default App
