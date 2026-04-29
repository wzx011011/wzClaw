import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { getAppDataDir } from '../paths'
import type { Workspace, Project } from '../../shared/types'

function getWorkspacesFilePath(): string {
  return path.join(getAppDataDir(), 'workspaces.json')
}

export class WorkspaceStore {
  private workspaces: Map<string, Workspace> = new Map()
  private loaded = false

  async load(): Promise<void> {
    if (this.loaded) return
    const filePath = getWorkspacesFilePath()
    try {
      const raw = await fsp.readFile(filePath, 'utf-8')
      const arr: Workspace[] = JSON.parse(raw)
      for (const w of arr) {
        this.workspaces.set(w.id, w)
      }
    } catch {
      // File doesn't exist yet or is corrupt — start empty
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    const filePath = getWorkspacesFilePath()
    const dir = path.dirname(filePath)
    await fsp.mkdir(dir, { recursive: true })
    const arr = Array.from(this.workspaces.values())
    await fsp.writeFile(filePath, JSON.stringify(arr, null, 2), 'utf-8')
  }

  async listWorkspaces(includeArchived = false): Promise<Workspace[]> {
    await this.load()
    const all = Array.from(this.workspaces.values())
    if (includeArchived) return all
    return all.filter((w) => !w.archived)
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    await this.load()
    return this.workspaces.get(id) ?? null
  }

  async createWorkspace(title: string, description?: string): Promise<Workspace> {
    await this.load()
    const now = Date.now()
    const workspace: Workspace = {
      id: crypto.randomUUID(),
      title,
      description,
      projects: [],
      createdAt: now,
      updatedAt: now,
      archived: false
    }
    this.workspaces.set(workspace.id, workspace)
    await this.save()
    return workspace
  }

  async updateWorkspace(
    id: string,
    updates: Partial<Pick<Workspace, 'title' | 'description' | 'archived' | 'lastSessionId' | 'progressSummary'>>
  ): Promise<Workspace> {
    await this.load()
    const workspace = this.workspaces.get(id)
    if (!workspace) throw new Error(`Workspace not found: ${id}`)
    Object.assign(workspace, updates, { updatedAt: Date.now() })
    await this.save()
    return workspace
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.load()
    if (!this.workspaces.delete(id)) throw new Error(`Workspace not found: ${id}`)
    await this.save()
  }

  async addProject(workspaceId: string, folderPath: string): Promise<Workspace> {
    await this.load()
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    // Prevent duplicate folder paths
    if (workspace.projects.some((p) => p.path === folderPath)) {
      return workspace
    }
    const project: Project = {
      id: crypto.randomUUID(),
      path: folderPath,
      name: path.basename(folderPath),
      addedAt: Date.now()
    }
    workspace.projects.push(project)
    workspace.updatedAt = Date.now()
    await this.save()
    return workspace
  }

  async removeProject(workspaceId: string, projectId: string): Promise<Workspace> {
    await this.load()
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    workspace.projects = workspace.projects.filter((p) => p.id !== projectId)
    workspace.updatedAt = Date.now()
    await this.save()
    return workspace
  }
}
