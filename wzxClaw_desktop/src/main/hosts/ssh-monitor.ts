// ============================================================
// SshMonitor — 通过 SSH 获取系统监控数据
// 解析 Linux 命令输出，兼容群晖 DSM / 通用 Linux
// ============================================================

import type { Host, HostMonitorData } from '../../shared/types'
import type { SshExecutor } from './ssh-executor'

interface CachedMonitor {
  data: HostMonitorData
  timestamp: number
}

export class SshMonitor {
  private executor: SshExecutor
  private cache: Map<string, CachedMonitor> = new Map()
  private static CACHE_TTL = 5000 // 5s 缓存

  constructor(executor: SshExecutor) {
    this.executor = executor
  }

  /** 获取完整系统监控数据 */
  async getAllMetrics(host: Host): Promise<HostMonitorData> {
    // 缓存检查
    const cached = this.cache.get(host.id)
    if (cached && Date.now() - cached.timestamp < SshMonitor.CACHE_TTL) {
      return cached.data
    }

    // 并行获取所有指标
    const [sysInfo, cpuResult, memResult, diskResult, netResult] = await Promise.all([
      this.executor.exec(host, 'uname -snrm').catch(() => ({ stdout: '' })),
      this.executor.exec(host, 'cat /proc/stat | head -2').catch(() => ({ stdout: '' })),
      this.executor.exec(host, 'free -m').catch(() => ({ stdout: '' })),
      this.executor.exec(host, 'df -h --output=source,target,size,used,avail,pcent -x tmpfs -x devtmpfs 2>/dev/null || df -h').catch(() => ({ stdout: '' })),
      this.executor.exec(host, 'cat /proc/net/dev').catch(() => ({ stdout: '' }))
    ])

    const uptimeResult = await this.executor.exec(host, 'cat /proc/uptime').catch(() => ({ stdout: '0 0' }))

    // 解析系统信息 uname -snrm → "Linux hostname 5.10.x x86_64"
    const unameParts = sysInfo.stdout.trim().split(/\s+/)
    const hostname = unameParts[1] || host.host
    const osName = unameParts[0] || 'Linux'
    const kernel = unameParts.slice(2).join(' ') || 'unknown'

    // 解析 uptime
    const uptimeSec = parseFloat(uptimeResult.stdout.split(' ')[0]) || 0

    // 解析 CPU（从 /proc/stat 两次采样计算使用率）
    const cpuInfo = await this.getCpuUsage(host)

    const data: HostMonitorData = {
      hostname,
      os: osName,
      kernel,
      uptime: Math.floor(uptimeSec),
      cpu: cpuInfo,
      memory: this.parseMemory(memResult.stdout),
      disks: this.parseDisk(diskResult.stdout),
      network: this.parseNetwork(netResult.stdout),
      timestamp: Date.now()
    }

    this.cache.set(host.id, { data, timestamp: Date.now() })
    return data
  }

  /** CPU 使用率：两次采样间隔 500ms */
  private async getCpuUsage(host: Host): Promise<HostMonitorData['cpu']> {
    try {
      // 获取 CPU 型号
      const cpuModelResult = await this.executor.exec(host, 'grep "model name" /proc/cpuinfo | head -1 | cut -d: -f2')
      const coresResult = await this.executor.exec(host, 'nproc')

      // 使用 top 批量模式获取 CPU 使用率（更通用）
      const topResult = await this.executor.exec(host, 'top -bn2 -d0.5 | grep "^%Cpu" | tail -1')
      let usagePercent = 0
      const topMatch = topResult.stdout.match(/([\d.]+)\s*id/)
      if (topMatch) {
        usagePercent = Math.round((100 - parseFloat(topMatch[1])) * 10) / 10
      }

      return {
        model: cpuModelResult.stdout.trim() || 'Unknown',
        cores: parseInt(coresResult.stdout.trim()) || 1,
        usagePercent
      }
    } catch {
      return { model: 'Unknown', cores: 1, usagePercent: 0 }
    }
  }

  /** 解析 free -m 输出 */
  private parseMemory(output: string): HostMonitorData['memory'] {
    const lines = output.trim().split('\n')
    // Mem: total used free shared buff/cache available
    const memLine = lines.find(l => l.startsWith('Mem:'))
    if (!memLine) return { totalMB: 0, usedMB: 0, availableMB: 0, usagePercent: 0 }

    const parts = memLine.split(/\s+/)
    const total = parseFloat(parts[1]) || 0
    const available = parseFloat(parts[6]) || 0
    const used = total - available
    const usagePercent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0

    return {
      totalMB: Math.round(total),
      usedMB: Math.round(used),
      availableMB: Math.round(available),
      usagePercent
    }
  }

  /** 解析 df -h 输出 */
  private parseDisk(output: string): HostMonitorData['disks'] {
    const lines = output.trim().split('\n')
    const disks: HostMonitorData['disks'] = []

    for (const line of lines.slice(1)) { // 跳过 header
      const parts = line.split(/\s+/)
      if (parts.length < 6) continue

      // 格式: Filesystem Mounted on Size Used Avail Use%
      // 或: Filesystem Size Used Avail Use% Mounted on
      let filesystem: string, mount: string, totalGB: number, usedGB: number, availableGB: number, usagePercent: number

      if (parts[1].startsWith('/')) {
        // --output 格式: source target size used avail pcent
        filesystem = parts[0]
        mount = parts[1]
        totalGB = this.parseSizeToGB(parts[2])
        usedGB = this.parseSizeToGB(parts[3])
        availableGB = this.parseSizeToGB(parts[4])
        usagePercent = parseFloat(parts[5]) || 0
      } else {
        // 标准 df -h 格式: Filesystem Size Used Avail Use% Mounted
        filesystem = parts[0]
        mount = parts[5]
        totalGB = this.parseSizeToGB(parts[1])
        usedGB = this.parseSizeToGB(parts[2])
        availableGB = this.parseSizeToGB(parts[3])
        usagePercent = parseFloat(parts[4]) || 0
      }

      // 跳过无意义的文件系统
      if (mount.startsWith('/dev/') || mount === '/dev/shm') continue

      disks.push({ filesystem, mount, totalGB, usedGB, availableGB, usagePercent })
    }

    return disks
  }

  /** 解析 /proc/net/dev 输出 */
  private parseNetwork(output: string): HostMonitorData['network'] {
    const lines = output.trim().split('\n')
    const interfaces: HostMonitorData['network'] = []

    for (const line of lines.slice(2)) { // 跳过 header
      const match = line.match(/^\s*(\w+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/)
      if (match) {
        const iface = match[1]
        // 跳过 lo
        if (iface === 'lo') continue
        interfaces.push({
          interface: iface,
          rxBytes: parseInt(match[2]) || 0,
          txBytes: parseInt(match[3]) || 0
        })
      }
    }

    return interfaces
  }

  /** 将 "50G", "500M" 等转换为 GB */
  private parseSizeToGB(size: string): number {
    const num = parseFloat(size)
    if (isNaN(num)) return 0
    const unit = size.replace(/[\d.]/g, '').toUpperCase()
    switch (unit) {
      case 'T': case 'TB': return Math.round(num * 1024 * 10) / 10
      case 'G': case 'GB': return Math.round(num * 10) / 10
      case 'M': case 'MB': return Math.round(num / 1024 * 100) / 100
      case 'K': case 'KB': return Math.round(num / 1024 / 1024 * 1000) / 1000
      default: return Math.round(num / 1024 / 1024 / 1024 * 10) / 10 // bytes
    }
  }
}
