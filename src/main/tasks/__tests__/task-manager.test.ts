import { describe, it, expect, beforeEach } from 'vitest'
import { TaskManager } from '../task-manager'
import type { TaskEvent } from '../task-manager'

describe('TaskManager', () => {
  let tm: TaskManager

  beforeEach(() => {
    tm = new TaskManager()
  })

  describe('createTask', () => {
    it('returns a task with correct fields', () => {
      const task = tm.createTask('Test subject', 'Test description')
      expect(task.id).toBe('task-1')
      expect(task.subject).toBe('Test subject')
      expect(task.description).toBe('Test description')
      expect(task.status).toBe('pending')
      expect(task.blockedBy).toEqual([])
      expect(task.createdAt).toBeGreaterThan(0)
      expect(task.updatedAt).toBeGreaterThan(0)
    })

    it('increments task IDs', () => {
      const t1 = tm.createTask('First')
      const t2 = tm.createTask('Second')
      expect(t1.id).toBe('task-1')
      expect(t2.id).toBe('task-2')
    })

    it('sets status to blocked when blockedBy references non-completed task', () => {
      const t1 = tm.createTask('Blocker', 'Must complete first')
      const t2 = tm.createTask('Dependent', 'Depends on blocker', [t1.id])
      expect(t2.status).toBe('blocked')
    })

    it('sets status to pending when blockedBy references completed task', () => {
      const t1 = tm.createTask('Blocker', 'Already done')
      tm.updateTask(t1.id, { status: 'completed' })
      const t2 = tm.createTask('Dependent', 'Blocker done', [t1.id])
      expect(t2.status).toBe('pending')
    })

    it('sets status to blocked when blockedBy references unknown task (forward reference)', () => {
      const t1 = tm.createTask('Dependent', 'References unknown', ['task-999'])
      expect(t1.status).toBe('blocked')
    })
  })

  describe('updateTask', () => {
    it('changes task status', () => {
      const task = tm.createTask('Test', 'Desc')
      const updated = tm.updateTask(task.id, { status: 'in_progress' })
      expect(updated?.status).toBe('in_progress')
    })

    it('changes task subject', () => {
      const task = tm.createTask('Old subject', 'Desc')
      const updated = tm.updateTask(task.id, { subject: 'New subject' })
      expect(updated?.subject).toBe('New subject')
    })

    it('changes task description', () => {
      const task = tm.createTask('Subject', 'Old desc')
      const updated = tm.updateTask(task.id, { description: 'New desc' })
      expect(updated?.description).toBe('New desc')
    })

    it('returns null for unknown task ID', () => {
      const result = tm.updateTask('task-999', { status: 'completed' })
      expect(result).toBeNull()
    })

    it('updates updatedAt timestamp', () => {
      const task = tm.createTask('Test', 'Desc')
      const before = task.updatedAt
      // Small delay to ensure timestamp difference
      const updated = tm.updateTask(task.id, { status: 'in_progress' })
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(before)
    })
  })

  describe('dependency unblocking', () => {
    it('unblocks dependent tasks when all blockers are completed', () => {
      const t1 = tm.createTask('Blocker 1', 'First')
      const t2 = tm.createTask('Blocker 2', 'Second')
      const t3 = tm.createTask('Dependent', 'Depends on both', [t1.id, t2.id])

      expect(t3.status).toBe('blocked')

      // Complete first blocker -- still blocked
      tm.updateTask(t1.id, { status: 'completed' })
      expect(tm.getTask(t3.id)?.status).toBe('blocked')

      // Complete second blocker -- should unblock
      tm.updateTask(t2.id, { status: 'completed' })
      expect(tm.getTask(t3.id)?.status).toBe('pending')
    })

    it('does not unblock if only some blockers are completed', () => {
      const t1 = tm.createTask('Blocker 1', 'First')
      const t2 = tm.createTask('Blocker 2', 'Second')
      const t3 = tm.createTask('Dependent', 'Depends on both', [t1.id, t2.id])

      tm.updateTask(t1.id, { status: 'completed' })
      expect(tm.getTask(t3.id)?.status).toBe('blocked')
    })

    it('emits task:updated when unblocking dependents', () => {
      const t1 = tm.createTask('Blocker', 'First')
      const t2 = tm.createTask('Dependent', 'Depends on blocker', [t1.id])

      const events: TaskEvent[] = []
      tm.onTaskEvent((e) => events.push(e))
      events.length = 0 // clear initial events

      tm.updateTask(t1.id, { status: 'completed' })

      // Should have task:updated for t1 (the explicit update) and for t2 (unblocked)
      const dependentUpdate = events.find(
        (e) => e.type === 'task:updated' && e.task.id === t2.id
      )
      expect(dependentUpdate).toBeDefined()
      expect(dependentUpdate!.type).toBe('task:updated')
      expect(dependentUpdate!.task.status).toBe('pending')
    })
  })

  describe('onTaskEvent', () => {
    it('receives task:created events', () => {
      const events: TaskEvent[] = []
      tm.onTaskEvent((e) => events.push(e))
      tm.createTask('Test', 'Desc')
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('task:created')
      expect(events[0].task.subject).toBe('Test')
    })

    it('receives task:updated events', () => {
      tm.createTask('Test', 'Desc')
      const events: TaskEvent[] = []
      tm.onTaskEvent((e) => events.push(e))
      tm.updateTask('task-1', { status: 'in_progress' })
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('task:updated')
      expect(events[0].task.status).toBe('in_progress')
    })

    it('unsubscribe removes listener', () => {
      const events: TaskEvent[] = []
      const unsub = tm.onTaskEvent((e) => events.push(e))
      unsub()
      tm.createTask('Test', 'Desc')
      expect(events).toHaveLength(0)
    })
  })

  describe('getAllTasks', () => {
    it('returns all created tasks', () => {
      tm.createTask('Task 1', 'Desc 1')
      tm.createTask('Task 2', 'Desc 2')
      tm.createTask('Task 3', 'Desc 3')
      expect(tm.getAllTasks()).toHaveLength(3)
    })
  })

  describe('clearTasks', () => {
    it('removes all tasks', () => {
      tm.createTask('Task 1', 'Desc 1')
      tm.createTask('Task 2', 'Desc 2')
      expect(tm.getAllTasks()).toHaveLength(2)

      tm.clearTasks()
      expect(tm.getAllTasks()).toHaveLength(0)
    })

    it('resets ID counter', () => {
      tm.createTask('Task 1', 'Desc 1')
      tm.clearTasks()
      const t = tm.createTask('Task 2', 'Desc 2')
      expect(t.id).toBe('task-1')
    })
  })

  describe('getTask', () => {
    it('returns task by ID', () => {
      const task = tm.createTask('Test', 'Desc')
      const found = tm.getTask(task.id)
      expect(found).toBe(task)
    })

    it('returns undefined for unknown ID', () => {
      expect(tm.getTask('task-999')).toBeUndefined()
    })
  })

  describe('blockedBy update', () => {
    it('re-evaluates status when blockedBy is updated', () => {
      const t1 = tm.createTask('Blocker', 'Done')
      tm.updateTask(t1.id, { status: 'completed' })

      const t2 = tm.createTask('Task', 'Desc')
      expect(t2.status).toBe('pending')

      // Add a blocker that is not completed
      tm.updateTask(t2.id, { blockedBy: ['task-999'] })
      expect(tm.getTask(t2.id)?.status).toBe('blocked')
    })
  })
})
