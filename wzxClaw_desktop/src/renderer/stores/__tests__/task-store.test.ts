import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTaskStore } from '../task-store'

describe('TaskStore', () => {
  beforeEach(() => {
    useTaskStore.setState({
      tasks: [
        { id: 't-1', title: 'Task One', description: 'First task', archived: false, projects: [] },
        { id: 't-2', title: 'Task Two', description: 'Second task', archived: false, projects: [] }
      ],
      activeTaskId: null,
      viewingTaskId: null,
      isLoading: false,
      error: null
    })
    vi.restoreAllMocks()
    ;(globalThis as any).window = {
      wzxclaw: {
        listTasks: vi.fn().mockResolvedValue([]),
        createTask: vi.fn().mockImplementation(({ title, description }) =>
          Promise.resolve({ id: 't-new', title, description, archived: false, projects: [] })
        ),
        updateTask: vi.fn().mockImplementation(({ taskId, updates }) =>
          Promise.resolve({ id: taskId, ...updates })
        ),
        deleteTask: vi.fn().mockResolvedValue(undefined),
        addTaskProject: vi.fn().mockResolvedValue({ id: 't-1', projects: [] }),
        removeTaskProject: vi.fn().mockResolvedValue({ id: 't-1', projects: [] })
      }
    }
  })

  describe('openTask / closeTask', () => {
    it('should set activeTaskId and clear viewingTaskId on openTask', () => {
      const { openTask } = useTaskStore.getState()
      useTaskStore.setState({ viewingTaskId: 't-2' })

      openTask('t-1')
      expect(useTaskStore.getState().activeTaskId).toBe('t-1')
      expect(useTaskStore.getState().viewingTaskId).toBeNull()
    })

    it('should set activeTaskId to null on closeTask', () => {
      useTaskStore.setState({ activeTaskId: 't-1' })

      const { closeTask } = useTaskStore.getState()
      closeTask()
      expect(useTaskStore.getState().activeTaskId).toBeNull()
    })
  })

  describe('openTaskDetail / closeTaskDetail', () => {
    it('should set viewingTaskId on openTaskDetail', () => {
      const { openTaskDetail } = useTaskStore.getState()
      openTaskDetail('t-2')
      expect(useTaskStore.getState().viewingTaskId).toBe('t-2')
    })

    it('should clear viewingTaskId on closeTaskDetail', () => {
      useTaskStore.setState({ viewingTaskId: 't-2' })

      const { closeTaskDetail } = useTaskStore.getState()
      closeTaskDetail()
      expect(useTaskStore.getState().viewingTaskId).toBeNull()
    })
  })

  describe('getActiveTask', () => {
    it('should return correct task when activeTaskId is set', () => {
      useTaskStore.setState({ activeTaskId: 't-1' })

      const task = useTaskStore.getState().getActiveTask()
      expect(task).not.toBeNull()
      expect(task!.id).toBe('t-1')
      expect(task!.title).toBe('Task One')
    })

    it('should return null when no active task', () => {
      const task = useTaskStore.getState().getActiveTask()
      expect(task).toBeNull()
    })
  })

  describe('getViewingTask', () => {
    it('should return correct task when viewingTaskId is set', () => {
      useTaskStore.setState({ viewingTaskId: 't-2' })

      const task = useTaskStore.getState().getViewingTask()
      expect(task).not.toBeNull()
      expect(task!.id).toBe('t-2')
      expect(task!.title).toBe('Task Two')
    })
  })

  describe('deleteTask', () => {
    it('should clear activeTaskId when deleting the active task', async () => {
      useTaskStore.setState({ activeTaskId: 't-1' })

      const { deleteTask } = useTaskStore.getState()
      await deleteTask('t-1')

      const state = useTaskStore.getState()
      expect(state.tasks).toHaveLength(1)
      expect(state.tasks[0].id).toBe('t-2')
      expect(state.activeTaskId).toBeNull()
    })
  })

  describe('createTask', () => {
    it('should append new task to tasks array', async () => {
      const { createTask } = useTaskStore.getState()
      const task = await createTask('New Task', 'A new task')

      expect(task.id).toBe('t-new')
      expect(task.title).toBe('New Task')
      expect(useTaskStore.getState().tasks).toHaveLength(3)
      expect(useTaskStore.getState().tasks[2].id).toBe('t-new')
    })
  })
})
