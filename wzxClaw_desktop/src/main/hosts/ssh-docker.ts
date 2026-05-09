// ============================================================
// SshDocker — 通过 SSH Docker CLI 管理容器
// ============================================================

import type { Host, DockerContainer } from '../../shared/types'
import type { SshExecutor } from './ssh-executor'

export class SshDocker {
  private executor: SshExecutor

  constructor(executor: SshExecutor) {
    this.executor = executor
  }

  /** 列出所有容器 */
  async listContainers(host: Host): Promise<DockerContainer[]> {
    const result = await this.executor.exec(
      host,
      'docker ps -a --format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.State}}\\t{{.Ports}}\\t{{.CreatedAt}}"'
    )

    if (!result.success) {
      throw new Error(`获取容器列表失败: ${result.stderr}`)
    }

    return result.stdout
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const parts = line.split('\t')
        const statusStr = parts[3] || ''
        const stateStr = (parts[4] || '').toLowerCase().trim() as DockerContainer['state']

        return {
          id: parts[0] || '',
          name: parts[1] || '',
          image: parts[2] || '',
          status: statusStr,
          state: ['running', 'exited', 'paused', 'restarting', 'dead'].includes(stateStr)
            ? stateStr
            : 'exited',
          ports: parts[5] || '',
          createdAt: this.parseDockerDate(parts[6] || '').getTime()
        }
      })
  }

  /** 获取容器日志 */
  async getContainerLogs(host: Host, containerId: string, tail = 100): Promise<string> {
    const result = await this.executor.exec(
      host,
      `docker logs --tail ${tail} ${containerId} 2>&1`
    )

    if (!result.success && result.exitCode !== 0) {
      // docker logs 即使成功也可能返回非 0 exit code（如果容器以非 0 退出）
      // 只有 stderr 有实际错误时才抛出
      if (result.stderr && !result.stdout) {
        throw new Error(`获取容器日志失败: ${result.stderr}`)
      }
    }

    return result.stdout || result.stderr
  }

  /** 容器操作：start / stop / restart / remove */
  async containerAction(
    host: Host,
    containerId: string,
    action: 'start' | 'stop' | 'restart' | 'remove'
  ): Promise<{ success: boolean; message: string }> {
    const cmd = action === 'remove'
      ? `docker rm -f ${containerId}`
      : `docker ${action} ${containerId}`

    const result = await this.executor.exec(host, cmd, 60_000)

    return {
      success: result.success,
      message: result.success
        ? `${action} 成功`
        : result.stderr || `${action} 失败`
    }
  }

  /** 获取容器资源使用统计 */
  async getContainerStats(host: Host, containerId: string): Promise<{
    cpuPercent: number
    memoryMB: number
    memoryLimitMB: number
    networkIO: string
    blockIO: string
  }> {
    const result = await this.executor.exec(
      host,
      `docker stats --no-stream --format "{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.NetIO}}\\t{{.BlockIO}}" ${containerId}`
    )

    if (!result.success) {
      throw new Error(`获取容器统计失败: ${result.stderr}`)
    }

    const parts = result.stdout.trim().split('\t')
    const cpuStr = parts[0] || '0%'
    const memStr = parts[1] || '0 / 0'
    const netIO = parts[2] || '0 / 0'
    const blockIO = parts[3] || '0 / 0'

    // 解析 "1.23%" → 1.23
    const cpuPercent = parseFloat(cpuStr.replace('%', '')) || 0

    // 解析 "50MiB / 2GiB" → 50, 2048
    const memParts = memStr.split(' / ')
    const memoryMB = this.parseMemValue(memParts[0])
    const memoryLimitMB = this.parseMemValue(memParts[1])

    return {
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memoryMB,
      memoryLimitMB,
      networkIO: netIO,
      blockIO
    }
  }

  /** 列出镜像 */
  async listImages(host: Host): Promise<Array<{
    repository: string
    tag: string
    id: string
    created: string
    size: string
  }>> {
    const result = await this.executor.exec(
      host,
      'docker images --format "{{.Repository}}\\t{{.Tag}}\\t{{.ID}}\\t{{.CreatedAt}}\\t{{.Size}}"'
    )

    if (!result.success) {
      throw new Error(`获取镜像列表失败: ${result.stderr}`)
    }

    return result.stdout
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const parts = line.split('\t')
        return {
          repository: parts[0] || '',
          tag: parts[1] || '',
          id: parts[2] || '',
          created: parts[3] || '',
          size: parts[4] || ''
        }
      })
  }

  /** 解析 Docker 日期格式 "2024-01-15 08:30:00 +0800 CST" */
  private parseDockerDate(dateStr: string): Date {
    try {
      // 尝试 ISO 格式
      const d = new Date(dateStr)
      if (!isNaN(d.getTime())) return d
      // 群晖 Docker 可能返回不同格式，回退到当前时间
      return new Date()
    } catch {
      return new Date()
    }
  }

  /** 解析 "50MiB" / "2GiB" 等为 MB */
  private parseMemValue(val: string): number {
    const num = parseFloat(val) || 0
    const unit = val.replace(/[\d.\s]/g, '').toUpperCase()
    switch (unit) {
      case 'GIB': case 'GB': return Math.round(num * 1024)
      case 'MIB': case 'MB': return Math.round(num)
      case 'KIB': case 'KB': return Math.round(num / 1024)
      default: return Math.round(num)
    }
  }
}
