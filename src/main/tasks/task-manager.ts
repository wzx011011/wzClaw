import type { AgentTask, TaskStatus } from '../../shared/types'

// ============================================================
// Task Event Types
// ============================================================

export type TaskEvent =
  | { type: 'task:created'; task: AgentTask }
  | { type: 'task:updated'; task: AgentTask }

// ============================================================
// TaskManager — manages agent tasks with dependency tracking
// (per TASK-01 through TASK-05)
// ============================================================

export class TaskManager {
  private tasks: Map<string, AgentTask> = new Map()
  private listeners: Set<(event: TaskEvent) => void> = new Set()
  private nextId: number = 1

  createTask(subject: string, description: string, blockedBy: string[] = []): AgentTask {
    const id = `task-${this.nextId++}`
    const now = Date.now()

    // Determine initial status: if any blockedBy task is not completed, set to 'blocked'
    let status: TaskStatus = 'pending'
    for (const blockerId of blockedBy) {
      const blocker = this.tasks.get(blockerId)
      if (blocker && blocker.status !== 'completed') {
        status = 'blocked'
        break
      }
      // If blocker doesn't exist yet, allow forward reference but treat as blocked
      if (!blocker) {
        status = 'blocked'
        break
      }
    }

    const task: AgentTask = {
      id,
      subject,
      description,
      status,
      blockedBy,
      createdAt: now,
      updatedAt: now
    }

    this.tasks.set(id, task)
    this.emit({ type: 'task:created', task })
    return task
  }

  updateTask(
    taskId: string,
    updates: Partial<Pick<AgentTask, 'status' | 'subject' | 'description' | 'blockedBy'>>
  ): AgentTask | null {
    const task = this.tasks.get(taskId)
    if (!task) return null

    // Apply updates
    if (updates.status !== undefined) task.status = updates.status
    if (updates.subject !== undefined) task.subject = updates.subject
    if (updates.description !== undefined) task.description = updates.description
    if (updates.blockedBy !== undefined) task.blockedBy = updates.blockedBy

    // Re-evaluate status if blockedBy was updated
    if (updates.blockedBy !== undefined) {
      let shouldBlock = false
      for (const blockerId of task.blockedBy) {
        const blocker = this.tasks.get(blockerId)
        if (blocker && blocker.status !== 'completed') {
          shouldBlock = true
          break
        }
        if (!blocker) {
          shouldBlock = true
          break
        }
      }
      if (shouldBlock && task.status !== 'blocked') {
        task.status = 'blocked'
      }
    }

    task.updatedAt = Date.now()
    this.emit({ type: 'task:updated', task })

    // If this task was just completed, check dependents for unblocking
    if (task.status === 'completed') {
      this.checkDependents(taskId)
    }

    return task
  }

  getTask(id: string): AgentTask | undefined {
    return this.tasks.get(id)
  }

  getAllTasks(): AgentTask[] {
    return Array.from(this.tasks.values())
  }

  clearTasks(): void {
    this.tasks.clear()
    this.nextId = 1
  }

  onTaskEvent(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Emit event to all subscribers */
  private emit(event: TaskEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  /** When a task completes, unblock any dependents whose all blockers are now completed */
  private checkDependents(completedTaskId: string): void {
    for (const [, task] of this.tasks) {
      if (task.blockedBy.includes(completedTaskId) && task.status === 'blocked') {
        const allCompleted = task.blockedBy.every((blockerId) => {
          const blocker = this.tasks.get(blockerId)
          return blocker?.status === 'completed'
        })

        if (allCompleted) {
          task.status = 'pending'
          task.updatedAt = Date.now()
          this.emit({ type: 'task:updated', task })
        }
      }
    }
  }
}

// Suppress unused import warning
void (0 as unknown as TaskStatus)
