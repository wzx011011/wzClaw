import IDELayout from './components/ide/IDELayout'
import TaskHomePage from './components/tasks/TaskHomePage'
import TaskDetailPage from './components/tasks/TaskDetailPage'
import { useTaskStore } from './stores/task-store'
import './styles/ide.css'
import './styles/chat.css'
import './styles/tasks.css'
import 'highlight.js/styles/vs2015.css'

function App(): JSX.Element {
  const activeTaskId = useTaskStore((s) => s.activeTaskId)
  const viewingTaskId = useTaskStore((s) => s.viewingTaskId)
  if (activeTaskId) return <IDELayout />
  if (viewingTaskId) return <TaskDetailPage />
  return <TaskHomePage />
}

export default App
