import { create } from 'zustand'
import type { Workspace } from '../../shared/types'

interface TaskStoreState {
  tasks: Workspace[]
  activeWorkspaceId: string | null
  viewingWorkspaceId: string | null
  isLoading: boolean
  error: string | null
}

interface TaskStoreActions {
  loadWorkspaces: () => Promise<void>
  createWorkspace: (title: string, description?: string) => Promise<Workspace>
  updateWorkspace: (taskId: string, updates: { title?: string; description?: string; archived?: boolean }) => Promise<void>
  deleteWorkspace: (taskId: string) => Promise<void>
  openWorkspaceDetail: (taskId: string) => void
  closeWorkspaceDetail: () => void
  openWorkspace: (taskId: string) => void
  closeWorkspace: () => void
  addProject: (taskId: string, folderPath: string) => Promise<void>
  removeProject: (taskId: string, projectId: string) => Promise<void>
  getActiveWorkspace: () => Workspace | null
  getViewingWorkspace: () => Workspace | null
}

type WorkspaceStore = TaskStoreState & TaskStoreActions

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  tasks: [],
  activeWorkspaceId: null,
  viewingWorkspaceId: null,
  isLoading: false,
  error: null,

  loadWorkspaces: async () => {
    set({ isLoading: true, error: null })
    try {
      const tasks = await window.wzxclaw.listWorkspaces()
      set({ tasks, isLoading: false })
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  createWorkspace: async (title, description) => {
    const task = await window.wzxclaw.createWorkspace({ title, description })
    set((s) => ({ tasks: [...s.tasks, task] }))
    return task
  },

  updateWorkspace: async (taskId, updates) => {
    const updated = await window.wzxclaw.updateWorkspace({ taskId, updates })
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId ? updated : t))
    }))
  },

  deleteWorkspace: async (taskId) => {
    await window.wzxclaw.deleteWorkspace({ taskId })
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== taskId),
      activeWorkspaceId: s.activeWorkspaceId === taskId ? null : s.activeWorkspaceId
    }))
  },

  openWorkspaceDetail: (taskId) => {
    set({ viewingWorkspaceId: taskId })
  },

  closeWorkspaceDetail: () => {
    set({ viewingWorkspaceId: null })
  },

  openWorkspace: (taskId) => {
    set({ activeWorkspaceId: taskId, viewingWorkspaceId: null })
  },

  closeWorkspace: () => {
    set({ activeWorkspaceId: null })
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

  getActiveWorkspace: () => {
    const { tasks, activeWorkspaceId } = get()
    if (!activeWorkspaceId) return null
    return tasks.find((t) => t.id === activeWorkspaceId) ?? null
  },

  getViewingWorkspace: () => {
    const { tasks, viewingWorkspaceId } = get()
    if (!viewingWorkspaceId) return null
    return tasks.find((t) => t.id === viewingWorkspaceId) ?? null
  }
}))
