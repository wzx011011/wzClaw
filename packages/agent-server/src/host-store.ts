// ============================================================
// HostStore — 远程主机 CRUD 持久化（JSON 文件存储）
// 存储 SSH 连接配置供 agent-server 使用
// ============================================================

import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'

export interface HostEntry {
  id: string
  name: string
  address: string
  port: number
  username: string
  authType: 'password' | 'key'
  tags?: string[]
  description?: string
  archived?: boolean
  createdAt: number
  updatedAt: number
}

export class HostStore {
  private hosts: Map<string, HostEntry> = new Map()
  private loaded = false
  private filePath: string
  private writeQueue = Promise.resolve()

  constructor(configDir: string) {
    this.filePath = path.join(configDir, 'hosts.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await fsp.readFile(this.filePath, 'utf-8')
      const arr: HostEntry[] = JSON.parse(raw)
      for (const h of arr) {
        this.hosts.set(h.id, h)
      }
    } catch {
      // 文件不存在 — 空列表
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const dir = path.dirname(this.filePath)
      await fsp.mkdir(dir, { recursive: true })
      const arr = Array.from(this.hosts.values())
      await fsp.writeFile(this.filePath, JSON.stringify(arr, null, 2), 'utf-8')
    })
    return this.writeQueue
  }

  async listHosts(includeArchived = false): Promise<HostEntry[]> {
    await this.load()
    const all = Array.from(this.hosts.values())
    if (includeArchived) return all
    return all.filter(h => !h.archived)
  }

  async getHost(id: string): Promise<HostEntry | null> {
    await this.load()
    return this.hosts.get(id) ?? null
  }

  async createHost(input: Omit<HostEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<HostEntry> {
    await this.load()
    const entry: HostEntry = {
      ...input,
      id: `host-${crypto.randomUUID().slice(0, 8)}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.hosts.set(entry.id, entry)
    await this.save()
    return entry
  }

  async updateHost(id: string, updates: Partial<Omit<HostEntry, 'id' | 'createdAt'>>): Promise<HostEntry> {
    await this.load()
    const existing = this.hosts.get(id)
    if (!existing) throw new Error(`Host not found: ${id}`)
    const updated: HostEntry = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    }
    this.hosts.set(id, updated)
    await this.save()
    return updated
  }

  async deleteHost(id: string): Promise<void> {
    await this.load()
    if (!this.hosts.has(id)) throw new Error(`Host not found: ${id}`)
    this.hosts.delete(id)
    await this.save()
  }
}
