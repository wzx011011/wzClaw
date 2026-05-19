// ============================================================
// Workspace Store — 共享工作区状态
//
// 仅依赖 DataSource，可同时服务 Electron IPC、WebSocket Web 端和手机端。
// ============================================================

import { create } from 'zustand'
import type { DataSource, SessionMeta, Workspace, WorkspaceUpdate } from '../data-source/types'

let currentDataSource: DataSource | null = null

export function setWorkspaceDataSource(dataSource: DataSource | null): void {
  currentDataSource = dataSource
}

function requireDataSource(): DataSource {
  if (!currentDataSource) throw new Error('DataSource is not ready')
  return currentDataSource
}

interface WorkspaceState {
  workspaces: Workspace[]
  viewingWorkspaceId: string | null
  activeWorkspaceId: string | null
  workspaceSessions: Record<string, SessionMeta[]>
  isLoading: boolean
  error: string | null
}

interface WorkspaceActions {
  loadWorkspaces(includeArchived?: boolean): Promise<void>
  createWorkspace(title: string, description?: string): Promise<Workspace>
  updateWorkspace(workspaceId: string, updates: WorkspaceUpdate): Promise<Workspace>
  deleteWorkspace(workspaceId: string): Promise<void>
  addProject(workspaceId: string, folderPath: string): Promise<Workspace>
  removeProject(workspaceId: string, projectId: string): Promise<Workspace>
  loadWorkspaceSessions(workspaceId: string): Promise<void>
  openWorkspaceDetail(workspaceId: string): void
  closeWorkspaceDetail(): void
  setActiveWorkspace(workspaceId: string | null): void
  getViewingWorkspace(): Workspace | null
  getActiveWorkspace(): Workspace | null
}

export type WorkspaceStore = WorkspaceState & WorkspaceActions

function replaceWorkspace(workspaces: Workspace[], workspace: Workspace): Workspace[] {
  return workspaces.some(item => item.id === workspace.id)
    ? workspaces.map(item => item.id === workspace.id ? workspace : item)
    : [workspace, ...workspaces]
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspaces: [],
  viewingWorkspaceId: null,
  activeWorkspaceId: null,
  workspaceSessions: {},
  isLoading: false,
  error: null,

  loadWorkspaces: async (includeArchived = true) => {
    set({ isLoading: true, error: null })
    try {
      const workspaces = await requireDataSource().listWorkspaces({ includeArchived })
      set({ workspaces })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ isLoading: false })
    }
  },

  createWorkspace: async (title, description) => {
    set({ error: null })
    try {
      const workspace = await requireDataSource().createWorkspace({ title, description })
      set({ workspaces: replaceWorkspace(get().workspaces, workspace) })
      return workspace
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  },

  updateWorkspace: async (workspaceId, updates) => {
    set({ error: null })
    try {
      const workspace = await requireDataSource().updateWorkspace(workspaceId, updates)
      set({ workspaces: replaceWorkspace(get().workspaces, workspace) })
      return workspace
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  },

  deleteWorkspace: async (workspaceId) => {
    set({ error: null })
    try {
      await requireDataSource().deleteWorkspace(workspaceId)
      set((state) => ({
        workspaces: state.workspaces.filter(workspace => workspace.id !== workspaceId),
        viewingWorkspaceId: state.viewingWorkspaceId === workspaceId ? null : state.viewingWorkspaceId,
        activeWorkspaceId: state.activeWorkspaceId === workspaceId ? null : state.activeWorkspaceId,
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  },

  addProject: async (workspaceId, folderPath) => {
    set({ error: null })
    try {
      const workspace = await requireDataSource().addWorkspaceProject(workspaceId, folderPath)
      set({ workspaces: replaceWorkspace(get().workspaces, workspace) })
      return workspace
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  },

  removeProject: async (workspaceId, projectId) => {
    set({ error: null })
    try {
      const workspace = await requireDataSource().removeWorkspaceProject(workspaceId, projectId)
      set({ workspaces: replaceWorkspace(get().workspaces, workspace) })
      return workspace
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  },

  loadWorkspaceSessions: async (workspaceId) => {
    try {
      const sessions = await requireDataSource().listSessions({ workspaceId })
      set((state) => ({
        workspaceSessions: { ...state.workspaceSessions, [workspaceId]: sessions },
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  openWorkspaceDetail: (workspaceId) => set({ viewingWorkspaceId: workspaceId }),
  closeWorkspaceDetail: () => set({ viewingWorkspaceId: null }),
  setActiveWorkspace: (workspaceId) => set({ activeWorkspaceId: workspaceId }),
  getViewingWorkspace: () => get().workspaces.find(workspace => workspace.id === get().viewingWorkspaceId) ?? null,
  getActiveWorkspace: () => get().workspaces.find(workspace => workspace.id === get().activeWorkspaceId) ?? null,
}))