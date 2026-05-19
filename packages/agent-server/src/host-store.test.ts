import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { HostStore } from './host-store.js'

describe('HostStore', () => {
  let tmpDir: string
  let store: HostStore

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-store-test-'))
    store = new HostStore(tmpDir)
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  it('starts with empty list', async () => {
    const hosts = await store.listHosts()
    expect(hosts).toEqual([])
  })

  it('creates and retrieves a host', async () => {
    const host = await store.createHost({
      name: 'nas',
      address: '192.168.1.100',
      port: 22,
      username: 'root',
      authType: 'key',
      description: 'My NAS',
    })
    expect(host.id).toBeTruthy()
    expect(host.name).toBe('nas')
    expect(host.address).toBe('192.168.1.100')

    const retrieved = await store.getHost(host.id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.name).toBe('nas')
  })

  it('lists hosts excluding archived', async () => {
    await store.createHost({ name: 'active', address: 'a', port: 22, username: 'root', authType: 'key' })
    await store.createHost({ name: 'archived', address: 'b', port: 22, username: 'root', authType: 'key', archived: true })

    const active = await store.listHosts()
    expect(active).toHaveLength(1)
    expect(active[0].name).toBe('active')

    const all = await store.listHosts(true)
    expect(all).toHaveLength(2)
  })

  it('updates a host', async () => {
    const host = await store.createHost({ name: 'before', address: '1.1.1.1', port: 22, username: 'root', authType: 'key' })
    const updated = await store.updateHost(host.id, { name: 'after', port: 2222 })
    expect(updated.name).toBe('after')
    expect(updated.port).toBe(2222)
    expect(updated.address).toBe('1.1.1.1') // unchanged
  })

  it('deletes a host', async () => {
    const host = await store.createHost({ name: 'delete-me', address: 'x', port: 22, username: 'root', authType: 'key' })
    await store.deleteHost(host.id)
    const retrieved = await store.getHost(host.id)
    expect(retrieved).toBeNull()
  })

  it('throws when updating nonexistent host', async () => {
    await expect(store.updateHost('nonexistent', { name: 'x' })).rejects.toThrow('Host not found')
  })

  it('throws when deleting nonexistent host', async () => {
    await expect(store.deleteHost('nonexistent')).rejects.toThrow('Host not found')
  })

  it('persists to disk and reloads', async () => {
    await store.createHost({ name: 'persist', address: '10.0.0.1', port: 22, username: 'admin', authType: 'password' })

    // 新 store 实例从同一目录加载
    const store2 = new HostStore(tmpDir)
    const hosts = await store2.listHosts()
    expect(hosts).toHaveLength(1)
    expect(hosts[0].name).toBe('persist')
    expect(hosts[0].authType).toBe('password')
  })
})
