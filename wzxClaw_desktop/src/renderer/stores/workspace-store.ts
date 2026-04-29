import { create } from 'zustand'
import type { Workspace } from '../../shared/types'

interface WorkspaceStoreState {
  tasks: Workspace[]
  activeWorkspaceId: string | null
  viewingWorkspaceId: string | null
  isLoading: boolean
  error: string | null
}

interface WorkspaceStoreActions {
  loadWorkspaces: () => Promise<void>
  createWorkspace: (title: string, description?: string) => Promise<Workspace>
  updateWorkspace: (workspaceId: string, updates: { title?: string; description?: string; archived?: boolean }) => Promise<void>
  deleteWorkspace: (workspaceId: string) => Promise<void>
  openWorkspaceDetail: (workspaceId: string) => void
  closeWorkspaceDetail: () => void
  openWorkspace: (workspaceId: string) => void
  closeWorkspace: () => void
  addProject: (workspaceId: string, folderPath: string) => Promise<void>
  removeProject: (workspaceId: string, projectId: string) => Promise<void>
  getActiveWorkspace: () => Workspace | null
  getViewingWorkspace: () => Workspace | null
}

type WorkspaceStore = WorkspaceStoreState & WorkspaceStoreActions

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
    const workspace = await window.wzxclaw.createWorkspace({ title, description })
    set((s) => ({ tasks: [...s.tasks, workspace] }))
    return workspace
  },

  updateWorkspace: async (workspaceId, updates) => {
    const updated = await window.wzxclaw.updateWorkspace({ workspaceId, updates })
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === workspaceId ? updated : t))
    }))
  },

  deleteWorkspace: async (workspaceId) => {
    await window.wzxclaw.deleteWorkspace({ workspaceId })
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== workspaceId),
      activeWorkspaceId: s.activeWorkspaceId === workspaceId ? null : s.activeWorkspaceId
    }))
  },

  openWorkspaceDetail: (workspaceId) => {
    set({ viewingWorkspaceId: workspaceId })
  },

  closeWorkspaceDetail: () => {
    set({ viewingWorkspaceId: null })
  },

  openWorkspace: (workspaceId) => {
    set({ activeWorkspaceId: workspaceId, viewingWorkspaceId: null })
  },

  closeWorkspace: () => {
    set({ activeWorkspaceId: null })
  },

  addProject: async (workspaceId, folderPath) => {
    const updated = await window.wzxclaw.addWorkspaceProject({ workspaceId, folderPath })
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === workspaceId ? updated : t))
    }))
  },

  removeProject: async (workspaceId, projectId) => {
    const updated = await window.wzxclaw.removeWorkspaceProject({ workspaceId, projectId })
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === workspaceId ? updated : t))
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
