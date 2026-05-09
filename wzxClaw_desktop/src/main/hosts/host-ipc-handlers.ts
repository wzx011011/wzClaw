// ============================================================
// Host IPC Handlers — 主机管理 IPC 通道注册
// 独立于主 ipc-handlers.ts，减少单文件体积
// ============================================================

import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { HostStore } from './host-store'
import type { SshManager } from './ssh-manager'
import type { SshCredentials } from './ssh-credentials'
import type { SshExecutor } from './ssh-executor'
import type { SshMonitor } from './ssh-monitor'
import type { SshSftp } from './ssh-sftp'
import type { SshDocker } from './ssh-docker'

interface HostDeps {
  hostStore: HostStore
  sshManager: SshManager
  credentials: SshCredentials
  executor: SshExecutor
  monitor: SshMonitor
  sftp: SshSftp
  docker: SshDocker
  getMainWindow: () => BrowserWindow | null
  onDataChanged?: (event: string, data: unknown) => void
}

export function registerHostHandlers(deps: HostDeps): void {
  const { hostStore, sshManager, credentials, executor, monitor, sftp, docker, getMainWindow, onDataChanged } = deps

  // ── CRUD ──

  ipcMain.handle(IPC_CHANNELS['host:list'], async (_e, payload) => {
    return hostStore.listHosts(payload?.includeArchived)
  })

  ipcMain.handle(IPC_CHANNELS['host:get'], async (_e, payload) => {
    return hostStore.getHost(payload.hostId)
  })

  ipcMain.handle(IPC_CHANNELS['host:create'], async (_e, payload) => {
    const host = await hostStore.createHost(payload)
    // 保存凭据
    if (payload.password) credentials.setPassword(host.id, payload.password)
    if (payload.keyPath) credentials.setKeyPath(host.id, payload.keyPath)
    await credentials.save()
    onDataChanged?.('host:changed', host)
    return host
  })

  ipcMain.handle(IPC_CHANNELS['host:update'], async (_e, payload) => {
    const { hostId, updates } = payload
    // 处理凭据更新
    if (updates.password !== undefined) {
      credentials.setPassword(hostId, updates.password)
      delete updates.password
    }
    if (updates.keyPath !== undefined) {
      credentials.setKeyPath(hostId, updates.keyPath)
      delete updates.keyPath
    }
    await credentials.save()

    // 断开旧连接（配置可能变了）
    if (updates.host || updates.port || updates.username || updates.authType) {
      sshManager.disconnect(hostId)
    }

    const host = await hostStore.updateHost(hostId, updates)
    onDataChanged?.('host:changed', host)
    return host
  })

  ipcMain.handle(IPC_CHANNELS['host:delete'], async (_e, payload) => {
    sshManager.disconnect(payload.hostId)
    credentials.removeHostCredentials(payload.hostId)
    await credentials.save()
    await hostStore.deleteHost(payload.hostId)
    onDataChanged?.('host:changed', null)
  })

  // ── 连接测试 ──

  ipcMain.handle(IPC_CHANNELS['host:test-connection'], async (_e, payload) => {
    const host = await hostStore.getHost(payload.hostId)
    if (!host) return { success: false, error: '主机不存在' }

    try {
      const client = await sshManager.connect(host)
      // 获取系统信息作为连接验证
      const result = await executor.exec(host, 'uname -snrm', 10_000)
      // 更新状态
      await hostStore.updateHost(host.id, {
        status: 'online',
        lastConnectedAt: Date.now()
      })
      const parts = result.stdout.trim().split(/\s+/)
      return {
        success: true,
        info: {
          os: parts[0] || 'Linux',
          hostname: parts[1] || host.host
        }
      }
    } catch (err: unknown) {
      await hostStore.updateHost(host.id, { status: 'offline' })
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  // ── 命令执行 ──

  ipcMain.handle(IPC_CHANNELS['host:exec'], async (_e, payload) => {
    const host = await hostStore.getHost(payload.hostId)
    if (!host) throw new Error('主机不存在')

    const result = await executor.exec(host, payload.command, payload.timeout ?? 30_000)
    return result
  })

  // ── 系统监控 ──

  ipcMain.handle(IPC_CHANNELS['host:monitor'], async (_e, payload) => {
    const host = await hostStore.getHost(payload.hostId)
    if (!host) throw new Error('主机不存在')

    return monitor.getAllMetrics(host)
  })

  // ── SFTP 文件操作 ──

  ipcMain.handle(IPC_CHANNELS['host:sftp:list'], async (_e, payload) => {
    const host = await hostStore.getHost(payload.hostId)
    if (!host) throw new Error('主机不存在')

    return sftp.listDir(host, payload.path)
  })

  ipcMain.handle(IPC_CHANNELS['host:sftp:download'], async (_e, payload) => {
    const host = await hostStore.getHost(payload.hostId)
    if (!host) throw new Error('主机不存在')

    await sftp.downloadFile(host, payload.remotePath, payload.localPath)
    return { success: true, localPath: payload.localPath }
  })

  ipcMain.handle(IPC_CHANNELS['host:sftp:upload'], async (_e, payload) => {
    const host = await hostStore.getHost(payload.hostId)
    if (!host) throw new Error('主机不存在')

    await sftp.uploadFile(host, payload.localPath, payload.remotePath)
    return { success: true, remotePath: payload.remotePath }
  })

  ipcMain.handle(IPC_CHANNELS['host:sftp:read'], async (_e, payload) => {
    const host = await hostStore.getHost(payload.hostId)
    if (!host) throw new Error('主机不存在')

    try {
      const result = await sftp.readFile(host, payload.path)
      return { content: result.content, size: result.size, path: payload.path }
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS['host:sftp:mkdir'], async (_e, payload) => {
    const host = await hostStore.getHost(payload.hostId)
    if (!host) throw new Error('主机不存在')

    await sftp.mkdir(host, payload.path)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS['host:sftp:delete'], async (_e, payload) => {
    const host = await hostStore.getHost(payload.hostId)
    if (!host) throw new Error('主机不存在')

    await sftp.delete(host, payload.path)
    return { success: true }
  })

  // ── Docker 管理 ──

  ipcMain.handle(IPC_CHANNELS['host:docker:list'], async (_e, payload) => {
    const host = await hostStore.getHost(payload.hostId)
    if (!host) throw new Error('主机不存在')

    return docker.listContainers(host)
  })

  ipcMain.handle(IPC_CHANNELS['host:docker:logs'], async (_e, payload) => {
    const host = await hostStore.getHost(payload.hostId)
    if (!host) throw new Error('主机不存在')

    const logs = await docker.getContainerLogs(host, payload.containerId, payload.tail ?? 100)
    return { logs, containerId: payload.containerId }
  })

  ipcMain.handle(IPC_CHANNELS['host:docker:action'], async (_e, payload) => {
    const host = await hostStore.getHost(payload.hostId)
    if (!host) throw new Error('主机不存在')

    const result = await docker.containerAction(host, payload.containerId, payload.action)
    return { success: result.success, containerId: payload.containerId, action: payload.action }
  })

  ipcMain.handle(IPC_CHANNELS['host:docker:stats'], async (_e, payload) => {
    const host = await hostStore.getHost(payload.hostId)
    if (!host) throw new Error('主机不存在')

    return docker.getContainerStats(host, payload.containerId)
  })

  ipcMain.handle(IPC_CHANNELS['host:docker:images'], async (_e, payload) => {
    const host = await hostStore.getHost(payload.hostId)
    if (!host) throw new Error('主机不存在')

    return docker.listImages(host)
  })
}
