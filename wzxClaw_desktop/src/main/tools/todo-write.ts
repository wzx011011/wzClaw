import { z } from 'zod'
import * as fsp from 'fs/promises'
import * as path from 'path'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { getUserDir, sanitizePath } from '../paths'

// ============================================================
// TodoWrite Tool — Session task list management
// ============================================================

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

const TodoItemSchema = z.object({
  content: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().min(1)
})

const TodoWriteSchema = z.object({
  todos: z.array(TodoItemSchema)
})

/**
 * TodoWrite — replaces the current session todo list atomically.
 * Notifies the renderer via IPC so the UI can display progress.
 *
 * Rules:
 * - Exactly ONE todo must be in_progress at a time
 * - completed todos stay in the list so the user can see progress
 * - Mark in_progress BEFORE starting work, completed IMMEDIATELY after
 */
export class TodoWriteTool implements Tool {
  readonly name = 'TodoWrite'
  readonly description = `Manage the current session's task list. Replaces the entire todo list atomically.

Use this tool proactively for multi-step tasks (3+ steps) to track progress and show the user what you're doing.

Rules:
- Exactly ONE todo must be in_progress at any time (not zero, not two)
- Mark a task in_progress BEFORE you start it
- Mark a task completed IMMEDIATELY after finishing — do not batch completions
- Keep completed tasks visible so the user can see overall progress
- Remove tasks that are no longer relevant rather than leaving them pending

When to use:
- Starting any task with 3 or more distinct steps
- When the user asks to track progress
- After completing a task (to mark it done)

When NOT to use:
- Single-step tasks
- Trivial fixes (typos, obvious one-liners)

The todo list is displayed in the UI. The user can see it update in real-time.`

  readonly requiresApproval = false
  readonly isReadOnly = true

  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete todo list (replaces existing list)',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Imperative form: what needs to be done (e.g. "Run tests")'
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current status of this task'
            },
            activeForm: {
              type: 'string',
              description: 'Present continuous form shown during execution (e.g. "Running tests")'
            }
          },
          required: ['content', 'status', 'activeForm']
        }
      }
    },
    required: ['todos']
  }

  private currentTodos: TodoItem[] = []
  private getWebContents: () => Electron.WebContents | null
  private onProgressUpdate?: (taskId: string, summary: string) => void

  constructor(getWebContents: () => Electron.WebContents | null) {
    this.getWebContents = getWebContents
  }

  /** Attach a callback to push progress summary to the task store. */
  setProgressCallback(cb: (taskId: string, summary: string) => void): void {
    this.onProgressUpdate = cb
  }

  getCurrentTodos(): TodoItem[] {
    return this.currentTodos
  }

  /** Inject persisted todos at session start (called by AgentLoop). */
  setCurrentTodos(todos: TodoItem[]): void {
    this.currentTodos = todos
  }

  /**
   * Load persisted todos for a task from disk.
   * Returns empty array if no file exists or the file is corrupt.
   */
  static async loadForTask(taskId: string): Promise<TodoItem[]> {
    const file = path.join(getUserDir(), 'tasks', sanitizePath(taskId), 'todos.json')
    try {
      const raw = await fsp.readFile(file, 'utf-8')
      const parsed = z.array(TodoItemSchema).safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : []
    } catch {
      return []
    }
  }

  /** Atomically write todos to disk (tmp + rename). Silently fails. */
  private async persistTodos(taskId: string, todos: TodoItem[]): Promise<void> {
    const taskDir = path.join(getUserDir(), 'tasks', sanitizePath(taskId))
    await fsp.mkdir(taskDir, { recursive: true })
    const file = path.join(taskDir, 'todos.json')
    const tmp = `${file}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(todos, null, 2), 'utf-8')
    await fsp.rename(tmp, file)
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = TodoWriteSchema.safeParse(input)
    if (!parsed.success) {
      return {
        output: `Invalid input: ${parsed.error.issues[0]?.message ?? 'unknown error'}`,
        isError: true
      }
    }

    const { todos } = parsed.data

    // Validate: at most one in_progress
    const inProgress = todos.filter((t) => t.status === 'in_progress')
    if (inProgress.length > 1) {
      return {
        output: `Invalid: exactly one todo must be in_progress at a time. Found ${inProgress.length} in_progress items.`,
        isError: true
      }
    }

    this.currentTodos = todos

    // Persist to disk (fire-and-forget, atomic write) — task-scoped
    if (context.taskId) {
      this.persistTodos(context.taskId, todos).catch(() => { /* ignore */ })

      // Push progress summary to task card
      if (this.onProgressUpdate) {
        const inProgressItem = todos.find(t => t.status === 'in_progress')
        const completed = todos.filter(t => t.status === 'completed').length
        const total = todos.length
        let summary = `${completed}/${total} 完成`
        if (inProgressItem) {
          summary += ` · 当前: ${inProgressItem.title}`
        }
        this.onProgressUpdate(context.taskId, summary)
      }
    }

    // Notify renderer
    const wc = this.getWebContents()
    if (wc && !wc.isDestroyed()) {
      wc.send(IPC_CHANNELS['todo:updated'], { todos })
    }

    const counts = {
      pending: todos.filter((t) => t.status === 'pending').length,
      in_progress: todos.filter((t) => t.status === 'in_progress').length,
      completed: todos.filter((t) => t.status === 'completed').length
    }

    return {
      output: `Todo list updated: ${counts.completed} completed, ${counts.in_progress} in progress, ${counts.pending} pending`,
      isError: false
    }
  }
}
