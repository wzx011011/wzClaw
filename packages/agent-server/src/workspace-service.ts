// ============================================================
// WorkspaceService — agent-server 工作区管理
//
// 与桌面端 WorkspaceStore 对齐，但由 agent-server 持久化，供 Web/手机端
// 通过 WebSocket 使用。桌面端仍可通过 IpcDataSource 使用本机 adapter。
// ============================================================

import BetterSqlite3 from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export interface Project {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly addedAt: number
}

export interface Workspace {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly projects: Project[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly archived: boolean
  readonly lastSessionId?: string
  readonly systemPrompt?: string
}

export interface WorkspaceUpdate {
  readonly title?: string
  readonly description?: string
  readonly archived?: boolean
  readonly lastSessionId?: string
  readonly systemPrompt?: string
}

interface WorkspaceRow {
  id: string
  title: string
  description: string | null
  projects: string
  created_at: number
  updated_at: number
  archived: number
  last_session_id: string | null
  system_prompt: string | null
}

export class WorkspaceService {
  private readonly db: BetterSqlite3.Database
  private readonly stmtList: BetterSqlite3.Statement
  private readonly stmtGet: BetterSqlite3.Statement
  private readonly stmtInsert: BetterSqlite3.Statement
  private readonly stmtUpdate: BetterSqlite3.Statement
  private readonly stmtDelete: BetterSqlite3.Statement

  constructor(dbPath: string) {
    this.db = new BetterSqlite3(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        projects TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        last_session_id TEXT,
        system_prompt TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_workspaces_updated_at
        ON workspaces(updated_at DESC);
    `)

    this.stmtList = this.db.prepare(
      'SELECT * FROM workspaces WHERE (? = 1 OR archived = 0) ORDER BY updated_at DESC, id DESC'
    )
    this.stmtGet = this.db.prepare('SELECT * FROM workspaces WHERE id = ?')
    this.stmtInsert = this.db.prepare(
      `INSERT INTO workspaces (id, title, description, projects, created_at, updated_at, archived, last_session_id, system_prompt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.stmtUpdate = this.db.prepare(
      `UPDATE workspaces
          SET title = ?, description = ?, projects = ?, updated_at = ?, archived = ?, last_session_id = ?, system_prompt = ?
        WHERE id = ?`
    )
    this.stmtDelete = this.db.prepare('DELETE FROM workspaces WHERE id = ?')
  }

  async listWorkspaces(includeArchived = false): Promise<Workspace[]> {
    const rows = this.stmtList.all(includeArchived ? 1 : 0) as WorkspaceRow[]
    return rows.map(row => this.fromRow(row))
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const row = this.stmtGet.get(id) as WorkspaceRow | undefined
    return row ? this.fromRow(row) : null
  }

  async createWorkspace(input: { title: string; description?: string }): Promise<Workspace> {
    const now = Date.now()
    const workspace: Workspace = {
      id: randomUUID(),
      title: input.title,
      description: input.description,
      projects: [],
      createdAt: now,
      updatedAt: now,
      archived: false,
    }
    this.stmtInsert.run(
      workspace.id,
      workspace.title,
      workspace.description ?? null,
      JSON.stringify(workspace.projects),
      workspace.createdAt,
      workspace.updatedAt,
      0,
      null,
      null,
    )
    return workspace
  }

  async updateWorkspace(id: string, updates: WorkspaceUpdate): Promise<Workspace> {
    const updateWs = this.db.transaction(() => {
      const current = this.requireWorkspaceSync(id)
      const next: Workspace = {
        ...current,
        title: updates.title ?? current.title,
        description: updates.description ?? current.description,
        archived: updates.archived ?? current.archived,
        lastSessionId: updates.lastSessionId ?? current.lastSessionId,
        systemPrompt: updates.systemPrompt ?? current.systemPrompt,
        updatedAt: Date.now(),
      }
      this.writeWorkspace(next)
      return next
    })
    return updateWs()
  }

  async deleteWorkspace(id: string): Promise<void> {
    const result = this.stmtDelete.run(id)
    if (result.changes === 0) throw new Error(`Workspace not found: ${id}`)
  }

  async addProject(workspaceId: string, folderPath: string): Promise<Workspace> {
    const addProj = this.db.transaction(() => {
      const current = this.requireWorkspaceSync(workspaceId)
      if (current.projects.some(project => project.path === folderPath)) return current
      const next: Workspace = {
        ...current,
        projects: [
          ...current.projects,
          {
            id: randomUUID(),
            path: folderPath,
            name: path.basename(folderPath) || folderPath,
            addedAt: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      }
      this.writeWorkspace(next)
      return next
    })
    return addProj()
  }

  async removeProject(workspaceId: string, projectId: string): Promise<Workspace> {
    const removeProj = this.db.transaction(() => {
      const current = this.requireWorkspaceSync(workspaceId)
      const next: Workspace = {
        ...current,
        projects: current.projects.filter(project => project.id !== projectId),
        updatedAt: Date.now(),
      }
      this.writeWorkspace(next)
      return next
    })
    return removeProj()
  }

  async getSessionDefaults(workspaceId?: string): Promise<{ workingDirectory?: string; projectRoots?: string[]; systemPrompt?: string }> {
    if (!workspaceId) return {}
    const workspace = await this.getWorkspace(workspaceId)
    if (!workspace || workspace.projects.length === 0) return {}
    const projectRoots = workspace.projects.map(project => project.path)
    return {
      workingDirectory: projectRoots[0],
      projectRoots,
      systemPrompt: workspace.systemPrompt,
    }
  }

  close(): void {
    this.db.close()
  }

  private async requireWorkspace(id: string): Promise<Workspace> {
    const workspace = await this.getWorkspace(id)
    if (!workspace) throw new Error(`Workspace not found: ${id}`)
    return workspace
  }

  private requireWorkspaceSync(id: string): Workspace {
    const row = this.stmtGet.get(id) as WorkspaceRow | undefined
    if (!row) throw new Error(`Workspace not found: ${id}`)
    return this.fromRow(row)
  }

  private writeWorkspace(workspace: Workspace): void {
    this.stmtUpdate.run(
      workspace.title,
      workspace.description ?? null,
      JSON.stringify(workspace.projects),
      workspace.updatedAt,
      workspace.archived ? 1 : 0,
      workspace.lastSessionId ?? null,
      workspace.systemPrompt ?? null,
      workspace.id,
    )
  }

  private fromRow(row: WorkspaceRow): Workspace {
    return {
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      projects: this.parseProjects(row.projects),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archived: row.archived === 1,
      lastSessionId: row.last_session_id ?? undefined,
      systemPrompt: row.system_prompt ?? undefined,
    }
  }

  private parseProjects(value: string): Project[] {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed)
        ? parsed.filter((item): item is Project => (
          item && typeof item === 'object' &&
          typeof item.id === 'string' &&
          typeof item.path === 'string' &&
          typeof item.name === 'string' &&
          typeof item.addedAt === 'number'
        ))
        : []
    } catch {
      return []
    }
  }
}