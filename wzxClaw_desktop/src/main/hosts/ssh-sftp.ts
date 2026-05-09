// ============================================================
// SshSftp — SFTP 文件操作
// ============================================================

import type { Host, SftpEntry } from '../../shared/types'
import type { SshManager } from './ssh-manager'
import type { Stats } from 'ssh2-streams'

export class SshSftp {
  private manager: SshManager

  constructor(manager: SshManager) {
    this.manager = manager
  }

  /** 列出目录内容 */
  async listDir(host: Host, remotePath: string): Promise<SftpEntry[]> {
    const client = await this.manager.connect(host)
    const sftp = await this.getSftp(client)

    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) {
          reject(new Error(`列出目录失败: ${err.message}`))
          return
        }

        const entries: SftpEntry[] = list.map(item => {
          const isDir = (item.attrs.mode! & 0o40000) !== 0
          return {
            name: item.filename,
            path: remotePath === '/' ? `/${item.filename}` : `${remotePath}/${item.filename}`,
            isDirectory: isDir,
            size: item.attrs.size ?? 0,
            modTime: (item.attrs.mtime ?? 0) * 1000, // 转为毫秒
            permissions: this.modeToPermissions(item.attrs.mode ?? 0)
          }
        })

        // 目录在前，文件在后，各自按名称排序
        entries.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name)
        })

        resolve(entries)
      })
    })
  }

  /** 获取文件/目录详情 */
  async stat(host: Host, remotePath: string): Promise<{ size: number; isDirectory: boolean; modTime: number; permissions: string }> {
    const client = await this.manager.connect(host)
    const sftp = await this.getSftp(client)

    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) {
          reject(new Error(`获取文件信息失败: ${err.message}`))
          return
        }
        resolve({
          size: stats.size,
          isDirectory: stats.isDirectory(),
          modTime: stats.mtime * 1000,
          permissions: this.modeToPermissions(stats.mode)
        })
      })
    })
  }

  /** 读取小文件内容（文本预览） */
  async readFile(host: Host, remotePath: string, maxSize = 1024 * 1024): Promise<{ content: string; size: number }> {
    const client = await this.manager.connect(host)
    const sftp = await this.getSftp(client)

    // 先检查文件大小
    const statInfo = await this.stat(host, remotePath)
    if (statInfo.size > maxSize) {
      throw new Error(`文件太大 (${this.formatSize(statInfo.size)})，超过 ${this.formatSize(maxSize)} 限制`)
    }

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      const stream = sftp.createReadStream(remotePath)

      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        resolve({
          content: Buffer.concat(chunks).toString('utf-8'),
          size: statInfo.size
        })
      })
      stream.on('error', (err: Error) => reject(new Error(`读取文件失败: ${err.message}`)))
    })
  }

  /** 下载文件 */
  async downloadFile(host: Host, remotePath: string, localPath: string): Promise<void> {
    const client = await this.manager.connect(host)
    const sftp = await this.getSftp(client)

    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => {
        if (err) reject(new Error(`下载失败: ${err.message}`))
        else resolve()
      })
    })
  }

  /** 上传文件 */
  async uploadFile(host: Host, localPath: string, remotePath: string): Promise<void> {
    const client = await this.manager.connect(host)
    const sftp = await this.getSftp(client)

    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err) => {
        if (err) reject(new Error(`上传失败: ${err.message}`))
        else resolve()
      })
    })
  }

  /** 创建目录 */
  async mkdir(host: Host, remotePath: string): Promise<void> {
    const client = await this.manager.connect(host)
    const sftp = await this.getSftp(client)

    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => {
        if (err) reject(new Error(`创建目录失败: ${err.message}`))
        else resolve()
      })
    })
  }

  /** 删除文件或空目录 */
  async delete(host: Host, remotePath: string, recursive = false): Promise<void> {
    if (recursive) {
      // 使用 rm -rf 更简单
      const { SshExecutor } = await import('./ssh-executor')
      const executor = new SshExecutor(this.manager)
      const result = await executor.exec(host, `rm -rf ${remotePath.replace(/'/g, "'\\''")}`)
      if (!result.success) throw new Error(`删除失败: ${result.stderr}`)
      return
    }

    const client = await this.manager.connect(host)
    const sftp = await this.getSftp(client)

    return new Promise((resolve, reject) => {
      // 先尝试删除文件，如果失败则尝试删除目录
      sftp.unlink(remotePath, (unlinkErr) => {
        if (!unlinkErr) { resolve(); return }
        sftp.rmdir(remotePath, (rmdirErr) => {
          if (rmdirErr) reject(new Error(`删除失败: ${rmdirErr.message}`))
          else resolve()
        })
      })
    })
  }

  /** 获取 SFTP 子系统连接 */
  private getSftp(client: import('ssh2').Client): Promise<import('ssh2').SFTPWrapper> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) reject(new Error(`SFTP 初始化失败: ${err.message}`))
        else resolve(sftp)
      })
    })
  }

  /** mode 数字转 rwxrwxrwx 字符串 */
  private modeToPermissions(mode: number): string {
    const perms = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx']
    const owner = perms[(mode >> 6) & 7]
    const group = perms[(mode >> 3) & 7]
    const other = perms[mode & 7]
    return owner + group + other
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`
  }
}
