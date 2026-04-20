import { create } from 'zustand'
import type { Task } from '../../shared/types'

interface TaskStoreState {
  tasks: Task[]
  activeTaskId: string | null
  isLoading: boolean
  error: string | null
}

interface TaskStoreActions {
  loadTasks: () => Promise<void>
  createTask: (title: string, description?: string) => Promise<Task>
  updateTask: (taskId: string, updates: { title?: string; description?: string; archived?: boolean }) => Promise<void>
  deleteTask: (taskId: string) => Promise<void>
  openTask: (taskId: string) => void
  closeTask: () => void
  addProject: (taskId: string, folderPath: string) => Promise<void>
  removeProject: (taskId: string, projectId: string) => Promise<void>
  getActiveTask: () => Task | null
}

type TaskStore = TaskStoreState & TaskStoreActions

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  activeTaskId: null,
  isLoading: false,
  error: null,

  loadTasks: async () => {
    set({ isLoading: true, error: null })
    try {
      const tasks = await window.wzxclaw.listTasks()
      set({ tasks, isLoading: false })
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  createTask: async (title, description) => {
    const task = await window.wzxclaw.createTask({ title, description })
    set((s) => ({ tasks: [...s.tasks, task] }))
    return task
  },

  updateTask: async (taskId, updates) => {
    const updated = await window.wzxclaw.updateTask({ taskId, updates })
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId ? updated : t))
    }))
  },

  deleteTask: async (taskId) => {
    await window.wzxclaw.deleteTask({ taskId })
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== taskId),
      activeTaskId: s.activeTaskId === taskId ? null : s.activeTaskId
    }))
  },

  openTask: (taskId) => {
    set({ activeTaskId: taskId })
  },

  closeTask: () => {
    set({ activeTaskId: null })
  },

  addProject: async (taskId, folderPath) => {
    const updated = await window.wzxclaw.addTaskProject({ taskId, folderPath })
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId ? updated : t))
    }))
  },

  removeProject: async (taskId, projectId) => {
    const updated = await window.wzxclaw.removeTaskProject({ taskId, projectId })
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId ? updated : t))
    }))
  },

  getActiveTask: () => {
    const { tasks, activeTaskId } = get()
    if (!activeTaskId) return null
    return tasks.find((t) => t.id === activeTaskId) ?? null
  }
}))
