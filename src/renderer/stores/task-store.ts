import { create } from 'zustand'
import type { AgentTask } from '../../shared/types'

// ============================================================
// Task Store — state management for task panel
// (per TASK-01 through TASK-05)
// ============================================================

interface TaskState {
  tasks: AgentTask[]
  panelVisible: boolean
}

interface TaskActions {
  init: () => () => void
  togglePanel: () => void
  showPanel: () => void
  loadTasks: () => Promise<void>
  setTasks: (tasks: AgentTask[]) => void
}

type TaskStore = TaskState & TaskActions

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  panelVisible: false,

  init: () => {
    // Subscribe to real-time task events from main process
    const unsubCreated = window.wzxclaw.onTaskCreated((task) => {
      const { tasks } = get()
      // Avoid duplicates
      if (!tasks.find((t) => t.id === task.id)) {
        set({ tasks: [...tasks, task] })
      }
    })

    const unsubUpdated = window.wzxclaw.onTaskUpdated((task) => {
      const { tasks } = get()
      set({
        tasks: tasks.map((t) => (t.id === task.id ? task : t))
      })
    })

    // Load initial tasks
    get().loadTasks()

    return () => {
      unsubCreated()
      unsubUpdated()
    }
  },

  togglePanel: () => {
    set((s) => ({ panelVisible: !s.panelVisible }))
  },

  showPanel: () => {
    set({ panelVisible: true })
  },

  loadTasks: async () => {
    try {
      const tasks = await window.wzxclaw.listTasks()
      set({ tasks })
    } catch {
      // Silently fail -- tasks will sync via IPC events
    }
  },

  setTasks: (tasks) => {
    set({ tasks })
  }
}))

// ============================================================
// Computed helpers
// ============================================================

export function getTaskCompletedCount(tasks: AgentTask[]): number {
  return tasks.filter((t) => t.status === 'completed').length
}

export function getTaskActiveCount(tasks: AgentTask[]): number {
  return tasks.filter((t) => t.status !== 'completed').length
}
