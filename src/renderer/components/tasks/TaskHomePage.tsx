import React, { useEffect, useState } from 'react'
import { useTaskStore } from '../../stores/task-store'
import TaskCard from './TaskCard'
import CreateTaskModal from './CreateTaskModal'

export default function TaskHomePage(): JSX.Element {
  const tasks = useTaskStore((s) => s.tasks)
  const isLoading = useTaskStore((s) => s.isLoading)
  const loadTasks = useTaskStore((s) => s.loadTasks)
  const createTask = useTaskStore((s) => s.createTask)
  const updateTask = useTaskStore((s) => s.updateTask)
  const deleteTask = useTaskStore((s) => s.deleteTask)
  const openTaskDetail = useTaskStore((s) => s.openTaskDetail)

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => {
    loadTasks()
  }, [loadTasks])

  const activeTasks = tasks.filter((t) => !t.archived)
  const archivedTasks = tasks.filter((t) => t.archived)
  const displayTasks = showArchived ? archivedTasks : activeTasks

  const handleCreate = async (title: string, description?: string) => {
    const task = await createTask(title, description)
    setShowCreateModal(false)
    openTaskDetail(task.id)
  }

  const handleArchive = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId)
    if (task) {
      updateTask(taskId, { archived: !task.archived })
    }
  }

  const handleDelete = (taskId: string) => {
    if (confirm('确定要删除这个任务吗？此操作不可撤销。')) {
      deleteTask(taskId)
    }
  }

  return (
    <div className="task-home">
      <div className="task-home-dragbar" />
      <div className="task-home-header">
        <h1 className="task-home-title">任务</h1>
        <div className="task-home-actions">
          <button
            className={`task-filter-btn${showArchived ? ' active' : ''}`}
            onClick={() => setShowArchived(!showArchived)}
          >
            {showArchived ? '显示活跃' : '显示归档'}
          </button>
          <button className="task-btn-primary" onClick={() => setShowCreateModal(true)}>
            + 新建任务
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="task-home-empty">加载中...</div>
      ) : displayTasks.length === 0 ? (
        <div className="task-home-empty">
          {showArchived ? '没有归档的任务' : '还没有任务，点击"新建任务"开始'}
        </div>
      ) : (
        <div className="task-grid">
          {displayTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onOpen={openTaskDetail}
              onArchive={handleArchive}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {showCreateModal && (
        <CreateTaskModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreate}
        />
      )}
    </div>
  )
}
