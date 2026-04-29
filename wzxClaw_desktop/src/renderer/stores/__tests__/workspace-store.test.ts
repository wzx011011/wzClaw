import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useWorkspaceStore } from '../workspace-store'

describe('WorkspaceStore', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      tasks: [
        { id: 't-1', title: 'Task One', description: 'First task', archived: false, projects: [] },
        { id: 't-2', title: 'Task Two', description: 'Second task', archived: false, projects: [] }
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
          Promise.resolve({ id: 't-new', title, description, archived: false, projects: [] })
        ),
        updateWorkspace: vi.fn().mockImplementation(({ taskId, updates }) =>
          Promise.resolve({ id: taskId, ...updates })
        ),
        deleteWorkspace: vi.fn().mockResolvedValue(undefined),
        addTaskProject: vi.fn().mockResolvedValue({ id: 't-1', projects: [] }),
        removeTaskProject: vi.fn().mockResolvedValue({ id: 't-1', projects: [] })
      }
    }
  })

  describe('openWorkspace / closeWorkspace', () => {
    it('should set activeWorkspaceId and clear viewingWorkspaceId on openWorkspace', () => {
      const { openWorkspace } = useWorkspaceStore.getState()
      useWorkspaceStore.setState({ viewingWorkspaceId: 't-2' })

      openWorkspace('t-1')
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('t-1')
      expect(useWorkspaceStore.getState().viewingWorkspaceId).toBeNull()
    })

    it('should set activeWorkspaceId to null on closeWorkspace', () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 't-1' })

      const { closeWorkspace } = useWorkspaceStore.getState()
      closeWorkspace()
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull()
    })
  })

  describe('openWorkspaceDetail / closeWorkspaceDetail', () => {
    it('should set viewingWorkspaceId on openWorkspaceDetail', () => {
      const { openWorkspaceDetail } = useWorkspaceStore.getState()
      openWorkspaceDetail('t-2')
      expect(useWorkspaceStore.getState().viewingWorkspaceId).toBe('t-2')
    })

    it('should clear viewingWorkspaceId on closeWorkspaceDetail', () => {
      useWorkspaceStore.setState({ viewingWorkspaceId: 't-2' })

      const { closeWorkspaceDetail } = useWorkspaceStore.getState()
      closeWorkspaceDetail()
      expect(useWorkspaceStore.getState().viewingWorkspaceId).toBeNull()
    })
  })

  describe('getActiveWorkspace', () => {
    it('should return correct task when activeWorkspaceId is set', () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 't-1' })

      const task = useWorkspaceStore.getState().getActiveWorkspace()
      expect(task).not.toBeNull()
      expect(task!.id).toBe('t-1')
      expect(task!.title).toBe('Task One')
    })

    it('should return null when no active task', () => {
      const task = useWorkspaceStore.getState().getActiveWorkspace()
      expect(task).toBeNull()
    })
  })

  describe('getViewingWorkspace', () => {
    it('should return correct task when viewingWorkspaceId is set', () => {
      useWorkspaceStore.setState({ viewingWorkspaceId: 't-2' })

      const task = useWorkspaceStore.getState().getViewingWorkspace()
      expect(task).not.toBeNull()
      expect(task!.id).toBe('t-2')
      expect(task!.title).toBe('Task Two')
    })
  })

  describe('deleteWorkspace', () => {
    it('should clear activeWorkspaceId when deleting the active task', async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 't-1' })

      const { deleteWorkspace } = useWorkspaceStore.getState()
      await deleteWorkspace('t-1')

      const state = useWorkspaceStore.getState()
      expect(state.tasks).toHaveLength(1)
      expect(state.tasks[0].id).toBe('t-2')
      expect(state.activeWorkspaceId).toBeNull()
    })
  })

  describe('createWorkspace', () => {
    it('should append new task to tasks array', async () => {
      const { createWorkspace } = useWorkspaceStore.getState()
      const task = await createWorkspace('New Task', 'A new task')

      expect(task.id).toBe('t-new')
      expect(task.title).toBe('New Task')
      expect(useWorkspaceStore.getState().tasks).toHaveLength(3)
      expect(useWorkspaceStore.getState().tasks[2].id).toBe('t-new')
    })
  })
})
