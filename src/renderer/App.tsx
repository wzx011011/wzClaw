import IDELayout from './components/ide/IDELayout'
import TaskHomePage from './components/tasks/TaskHomePage'
import { useTaskStore } from './stores/task-store'
import './styles/ide.css'
import './styles/chat.css'
import './styles/tasks.css'
import 'highlight.js/styles/vs2015.css'

function App(): JSX.Element {
  const activeTaskId = useTaskStore((s) => s.activeTaskId)
  return activeTaskId ? <IDELayout /> : <TaskHomePage />
}

export default App
