import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useWorkspaceStore } from '../workspace-store'

describe('WorkspaceStore', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      tasks: [
        { id: 'w-1', title: 'Workspace One', description: 'First workspace', archived: false, projects: [] },
        { id: 'w-2', title: 'Workspace Two', description: 'Second workspace', archived: false, projects: [] }
      ],
      activeWorkspaceId: null,
      viewingWorkspaceId: null,
      isLoading: false,
      error: null
    })
    vi.restoreAllMocks()
    ;(globalThis as any).window = {
      wzxclaw: {
        listWorkspaces: vi.fn().mockResolvedValue([]),
        createWorkspace: vi.fn().mockImplementation(({ title, description }) =>
          Promise.resolve({ id: 'w-new', title, description, archived: false, projects: [] })
        ),
        updateWorkspace: vi.fn().mockImplementation(({ workspaceId, updates }) =>
          Promise.resolve({ id: workspaceId, ...updates })
        ),
        deleteWorkspace: vi.fn().mockResolvedValue(undefined),
        addWorkspaceProject: vi.fn().mockResolvedValue({ id: 'w-1', projects: [] }),
        removeWorkspaceProject: vi.fn().mockResolvedValue({ id: 'w-1', projects: [] })
      }
    }
  })

  describe('openWorkspace / closeWorkspace', () => {
    it('should set activeWorkspaceId and clear viewingWorkspaceId on openWorkspace', () => {
      const { openWorkspace } = useWorkspaceStore.getState()
      useWorkspaceStore.setState({ viewingWorkspaceId: 'w-2' })

      openWorkspace('w-1')
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('w-1')
      expect(useWorkspaceStore.getState().viewingWorkspaceId).toBeNull()
    })

    it('should set activeWorkspaceId to null on closeWorkspace', () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'w-1' })

      const { closeWorkspace } = useWorkspaceStore.getState()
      closeWorkspace()
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull()
    })
  })

  describe('openWorkspaceDetail / closeWorkspaceDetail', () => {
    it('should set viewingWorkspaceId on openWorkspaceDetail', () => {
      const { openWorkspaceDetail } = useWorkspaceStore.getState()
      openWorkspaceDetail('w-2')
      expect(useWorkspaceStore.getState().viewingWorkspaceId).toBe('w-2')
    })

    it('should clear viewingWorkspaceId on closeWorkspaceDetail', () => {
      useWorkspaceStore.setState({ viewingWorkspaceId: 'w-2' })

      const { closeWorkspaceDetail } = useWorkspaceStore.getState()
      closeWorkspaceDetail()
      expect(useWorkspaceStore.getState().viewingWorkspaceId).toBeNull()
    })
  })

  describe('getActiveWorkspace', () => {
    it('should return correct workspace when activeWorkspaceId is set', () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'w-1' })

      const workspace = useWorkspaceStore.getState().getActiveWorkspace()
      expect(workspace).not.toBeNull()
      expect(workspace!.id).toBe('w-1')
      expect(workspace!.title).toBe('Workspace One')
    })

    it('should return null when no active workspace', () => {
      const workspace = useWorkspaceStore.getState().getActiveWorkspace()
      expect(workspace).toBeNull()
    })
  })

  describe('getViewingWorkspace', () => {
    it('should return correct workspace when viewingWorkspaceId is set', () => {
      useWorkspaceStore.setState({ viewingWorkspaceId: 'w-2' })

      const workspace = useWorkspaceStore.getState().getViewingWorkspace()
      expect(workspace).not.toBeNull()
      expect(workspace!.id).toBe('w-2')
      expect(workspace!.title).toBe('Workspace Two')
    })
  })

  describe('deleteWorkspace', () => {
    it('should clear activeWorkspaceId when deleting the active workspace', async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'w-1' })

      const { deleteWorkspace } = useWorkspaceStore.getState()
      await deleteWorkspace('w-1')

      const state = useWorkspaceStore.getState()
      expect(state.tasks).toHaveLength(1)
      expect(state.tasks[0].id).toBe('w-2')
      expect(state.activeWorkspaceId).toBeNull()
    })
  })

  describe('createWorkspace', () => {
    it('should append new workspace to tasks array', async () => {
      const { createWorkspace } = useWorkspaceStore.getState()
      const workspace = await createWorkspace('New Workspace', 'A new workspace')

      expect(workspace.id).toBe('w-new')
      expect(workspace.title).toBe('New Workspace')
      expect(useWorkspaceStore.getState().tasks).toHaveLength(3)
      expect(useWorkspaceStore.getState().tasks[2].id).toBe('w-new')
    })
  })
})
