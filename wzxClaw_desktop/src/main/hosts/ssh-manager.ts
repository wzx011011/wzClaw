// ============================================================
// SshManager — SSH 连接池 + 生命周期管理
// 维护 Map<hostId, Client> 连接池，支持心跳保活和自动重连
// ============================================================

import { Client, ClientChannel, ConnectConfig } from 'ssh2'
import type { Host } from '../../shared/types'
import { SshCredentials } from './ssh-credentials'

interface ManagedConnection {
  client: Client
  hostId: string
  connected: boolean
  lastActivity: number
  keepaliveTimer: ReturnType<typeof setInterval> | null
}

export class SshManager {
  private connections: Map<string, ManagedConnection> = new Map()
  private credentials: SshCredentials

  constructor(credentials: SshCredentials) {
    this.credentials = credentials
  }

  /** 连接到主机，返回已建立连接或新建连接 */
  async connect(host: Host): Promise<Client> {
    // 复用已有连接
    const existing = this.connections.get(host.id)
    if (existing?.connected) {
      existing.lastActivity = Date.now()
      return existing.client
    }

    // 清理旧连接
    if (existing) {
      this.destroyConnection(existing)
    }

    const client = new Client()
    const config = this.buildConfig(host)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.destroy()
        reject(new Error(`SSH 连接超时: ${host.host}:${host.port}`))
      }, 15000)

      client.on('ready', () => {
        clearTimeout(timeout)
        const conn: ManagedConnection = {
          client,
          hostId: host.id,
          connected: true,
          lastActivity: Date.now(),
          keepaliveTimer: null
        }
        // 心跳保活
        conn.keepaliveTimer = setInterval(() => {
          if (conn.connected) {
            // 通过执行空命令检测连接是否存活
            client.exec('true', (err) => {
              if (err) {
                conn.connected = false
                this.connections.delete(host.id)
                if (conn.keepaliveTimer) clearInterval(conn.keepaliveTimer)
              }
            })
          }
        }, 30_000)

        this.connections.set(host.id, conn)
        resolve(client)
      })

      client.on('error', (err) => {
        clearTimeout(timeout)
        const conn = this.connections.get(host.id)
        if (conn) {
          conn.connected = false
          if (conn.keepaliveTimer) clearInterval(conn.keepaliveTimer)
        }
        reject(new Error(`SSH 连接失败: ${err.message}`))
      })

      client.on('close', () => {
        const conn = this.connections.get(host.id)
        if (conn) {
          conn.connected = false
          if (conn.keepaliveTimer) clearInterval(conn.keepaliveTimer)
        }
      })

      client.on('end', () => {
        const conn = this.connections.get(host.id)
        if (conn) conn.connected = false
      })

      client.connect(config)
    })
  }

  /** 断开指定主机连接 */
  disconnect(hostId: string): void {
    const conn = this.connections.get(hostId)
    if (conn) {
      this.destroyConnection(conn)
      this.connections.delete(hostId)
    }
  }

  /** 断开所有连接 */
  disconnectAll(): void {
    for (const conn of this.connections.values()) {
      this.destroyConnection(conn)
    }
    this.connections.clear()
  }

  /** 检查连接是否活跃 */
  isConnected(hostId: string): boolean {
    return this.connections.get(hostId)?.connected ?? false
  }

  /** 获取已连接的 client，如果未连接则返回 null */
  getClient(hostId: string): Client | null {
    const conn = this.connections.get(hostId)
    if (conn?.connected) return conn.client
    return null
  }

  /** 构建 SSH 连接配置 */
  private buildConfig(host: Host): ConnectConfig {
    const config: ConnectConfig = {
      host: host.host,
      port: host.port,
      username: host.username,
      readyTimeout: 15_000,
      keepaliveInterval: 30_000,
      keepaliveCountMax: 3,
      algorithms: {
        // 兼容老旧 SSH 服务器
        kex: [
          'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
          'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'
        ]
      }
    }

    if (host.authType === 'password') {
      const password = this.credentials.getPassword(host.id)
      if (password) config.password = password
    } else {
      const keyContent = this.credentials.getKeyContent(host.id)
      const keyPath = this.credentials.getKeyPath(host.id)
      if (keyContent) {
        config.privateKey = keyContent
      } else if (keyPath) {
        // ssh2 会自动读取文件
        config.privateKey = require('fs').readFileSync(keyPath)
      }
    }

    return config
  }

  private destroyConnection(conn: ManagedConnection): void {
    conn.connected = false
    if (conn.keepaliveTimer) clearInterval(conn.keepaliveTimer)
    try {
      conn.client.end()
    } catch {
      // 忽略关闭错误
    }
  }
}
