// ============================================================
// SshCredentials — SSH 凭据加密存储（复用 safeStorage 体系）
// 密码/私钥加密后存储在 keys.enc 中，key 前缀为 ssh:{hostId}
// ============================================================

import { safeStorage } from 'electron'
import fs from 'fs'
import { getKeysPath } from '../paths'

interface EncryptedKeys {
  [key: string]: string // base64-encoded encrypted buffer
}

export class SshCredentials {
  private keysPath: string
  /** 内存中的明文凭据，key = ssh:{hostId}:{field} */
  private credentials: Map<string, string> = new Map()
  /** 从磁盘加载的完整加密数据（包含 API keys 和 SSH 凭据） */
  private encryptedData: EncryptedKeys = {}

  constructor() {
    this.keysPath = getKeysPath()
  }

  /** 从磁盘加载加密数据 */
  async load(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.keysPath, 'utf-8')
      this.encryptedData = JSON.parse(raw)
    } catch {
      this.encryptedData = {}
    }

    // 解密 SSH 凭据
    for (const [key, base64Encrypted] of Object.entries(this.encryptedData)) {
      if (!key.startsWith('ssh:')) continue
      try {
        const encryptedBuf = Buffer.from(base64Encrypted, 'base64')
        if (safeStorage.isEncryptionAvailable()) {
          const plaintext = safeStorage.decryptString(encryptedBuf)
          this.credentials.set(key, plaintext)
        } else {
          this.credentials.set(key, base64Encrypted)
        }
      } catch (decryptErr) {
        console.error(`[ssh-credentials] 解密失败: ${key}`, decryptErr)
      }
    }
  }

  /** 获取 SSH 密码 */
  getPassword(hostId: string): string | undefined {
    return this.credentials.get(`ssh:${hostId}:password`)
  }

  /** 获取 SSH 私钥路径 */
  getKeyPath(hostId: string): string | undefined {
    return this.credentials.get(`ssh:${hostId}:keyPath`)
  }

  /** 获取 SSH 私钥内容 */
  getKeyContent(hostId: string): string | undefined {
    return this.credentials.get(`ssh:${hostId}:keyContent`)
  }

  /** 保存 SSH 密码 */
  setPassword(hostId: string, password: string): void {
    this.credentials.set(`ssh:${hostId}:password`, password)
  }

  /** 保存 SSH 私钥路径 */
  setKeyPath(hostId: string, keyPath: string): void {
    this.credentials.set(`ssh:${hostId}:keyPath`, keyPath)
  }

  /** 保存 SSH 私钥内容 */
  setKeyContent(hostId: string, content: string): void {
    this.credentials.set(`ssh:${hostId}:keyContent`, content)
  }

  /** 删除某主机所有凭据 */
  removeHostCredentials(hostId: string): void {
    const prefix = `ssh:${hostId}:`
    for (const key of this.credentials.keys()) {
      if (key.startsWith(prefix)) {
        this.credentials.delete(key)
      }
    }
  }

  /** 持久化到磁盘（与 API keys 共用 keys.enc） */
  async save(): Promise<void> {
    // 加密 SSH 凭据
    for (const [key, plaintext] of this.credentials.entries()) {
      if (safeStorage.isEncryptionAvailable()) {
        const encryptedBuf = safeStorage.encryptString(plaintext)
        this.encryptedData[key] = encryptedBuf.toString('base64')
      } else {
        this.encryptedData[key] = Buffer.from(plaintext, 'utf-8').toString('base64')
      }
    }

    await fs.promises.writeFile(
      this.keysPath,
      JSON.stringify(this.encryptedData, null, 2),
      'utf-8'
    )
  }
}
