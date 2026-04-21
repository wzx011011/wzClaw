import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { getAppDataDir } from '../paths'
import type { Task, Project } from '../../shared/types'

function getTasksFilePath(): string {
  return path.join(getAppDataDir(), 'tasks.json')
}

export class TaskStore {
  private tasks: Map<string, Task> = new Map()
  private loaded = false

  async load(): Promise<void> {
    if (this.loaded) return
    const filePath = getTasksFilePath()
    try {
      const raw = await fsp.readFile(filePath, 'utf-8')
      const arr: Task[] = JSON.parse(raw)
      for (const t of arr) {
        this.tasks.set(t.id, t)
      }
    } catch {
      // File doesn't exist yet or is corrupt — start empty
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    const filePath = getTasksFilePath()
    const dir = path.dirname(filePath)
    await fsp.mkdir(dir, { recursive: true })
    const arr = Array.from(this.tasks.values())
    await fsp.writeFile(filePath, JSON.stringify(arr, null, 2), 'utf-8')
  }

  async listTasks(includeArchived = false): Promise<Task[]> {
    await this.load()
    const all = Array.from(this.tasks.values())
    if (includeArchived) return all
    return all.filter((t) => !t.archived)
  }

  async getTask(id: string): Promise<Task | null> {
    await this.load()
    return this.tasks.get(id) ?? null
  }

  async createTask(title: string, description?: string): Promise<Task> {
    await this.load()
    const now = Date.now()
    const task: Task = {
      id: crypto.randomUUID(),
      title,
      description,
      projects: [],
      createdAt: now,
      updatedAt: now,
      archived: false
    }
    this.tasks.set(task.id, task)
    await this.save()
    return task
  }

  async updateTask(
    id: string,
    updates: Partial<Pick<Task, 'title' | 'description' | 'archived' | 'lastSessionId' | 'progressSummary'>>
  ): Promise<Task> {
    await this.load()
    const task = this.tasks.get(id)
    if (!task) throw new Error(`Task not found: ${id}`)
    Object.assign(task, updates, { updatedAt: Date.now() })
    await this.save()
    return task
  }

  async deleteTask(id: string): Promise<void> {
    await this.load()
    if (!this.tasks.delete(id)) throw new Error(`Task not found: ${id}`)
    await this.save()
  }

  async addProject(taskId: string, folderPath: string): Promise<Task> {
    await this.load()
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)
    // Prevent duplicate folder paths
    if (task.projects.some((p) => p.path === folderPath)) {
      return task
    }
    const project: Project = {
      id: crypto.randomUUID(),
      path: folderPath,
      name: path.basename(folderPath),
      addedAt: Date.now()
    }
    task.projects.push(project)
    task.updatedAt = Date.now()
    await this.save()
    return task
  }

  async removeProject(taskId: string, projectId: string): Promise<Task> {
    await this.load()
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)
    task.projects = task.projects.filter((p) => p.id !== projectId)
    task.updatedAt = Date.now()
    await this.save()
    return task
  }
}
