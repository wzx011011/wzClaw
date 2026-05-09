// ============================================================
// HostStore — 主机 CRUD 持久化（复用 WorkspaceStore 模式）
// ============================================================

import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { getAppDataDir } from '../paths'
import type { Host } from '../../shared/types'

function getHostsFilePath(): string {
  return path.join(getAppDataDir(), 'hosts.json')
}

export class HostStore {
  private hosts: Map<string, Host> = new Map()
  private loaded = false

  async load(): Promise<void> {
    if (this.loaded) return
    const filePath = getHostsFilePath()
    try {
      const raw = await fsp.readFile(filePath, 'utf-8')
      const arr: Host[] = JSON.parse(raw)
      for (const h of arr) {
        this.hosts.set(h.id, h)
      }
    } catch {
      // 文件不存在或损坏 — 空列表
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    const filePath = getHostsFilePath()
    const dir = path.dirname(filePath)
    await fsp.mkdir(dir, { recursive: true })
    const arr = Array.from(this.hosts.values())
    await fsp.writeFile(filePath, JSON.stringify(arr, null, 2), 'utf-8')
  }

  async listHosts(includeArchived = false): Promise<Host[]> {
    await this.load()
    const all = Array.from(this.hosts.values())
    if (includeArchived) return all
    return all.filter(h => !h.archived)
  }

  async getHost(id: string): Promise<Host | null> {
    await this.load()
    return this.hosts.get(id) ?? null
  }

  async createHost(params: {
    name: string
    host: string
    port?: number
    username: string
    authType: 'password' | 'key'
    description?: string
    tags?: string[]
  }): Promise<Host> {
    await this.load()
    const now = Date.now()
    const host: Host = {
      id: crypto.randomUUID(),
      name: params.name,
      host: params.host,
      port: params.port ?? 22,
      username: params.username,
      authType: params.authType,
      description: params.description,
      tags: params.tags,
      status: 'unknown',
      createdAt: now,
      updatedAt: now,
      archived: false
    }
    this.hosts.set(host.id, host)
    await this.save()
    return host
  }

  async updateHost(
    id: string,
    updates: Partial<Pick<Host, 'name' | 'host' | 'port' | 'username' | 'authType' | 'description' | 'tags' | 'archived' | 'status' | 'lastConnectedAt'>>
  ): Promise<Host> {
    await this.load()
    const host = this.hosts.get(id)
    if (!host) throw new Error(`Host not found: ${id}`)
    Object.assign(host, updates, { updatedAt: Date.now() })
    await this.save()
    return host
  }

  async deleteHost(id: string): Promise<void> {
    await this.load()
    if (!this.hosts.delete(id)) throw new Error(`Host not found: ${id}`)
    await this.save()
  }
}
