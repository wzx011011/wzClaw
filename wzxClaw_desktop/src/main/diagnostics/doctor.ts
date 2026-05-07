// ============================================================
// Doctor — 环境诊断检查
// /doctor 命令调用，检查 Node、Git、API keys、MCP、磁盘空间等
// ============================================================

import { exec } from 'child_process'
import os from 'os'
import fs from 'fs'
import type { MCPManager } from '../mcp/mcp-manager'

export interface DoctorCheck {
  name: string
  status: 'ok' | 'warn' | 'error'
  message: string
  fix?: string
}

export class Doctor {
  /**
   * 运行所有诊断检查
   */
  static async run(opts: {
    mcpManager?: MCPManager
    apiKeyConfigured: boolean
    provider: string
    model: string
  }): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = []

    // 并发运行独立检查
    const [nodeCheck, gitCheck, diskCheck, platformCheck] = await Promise.all([
      Doctor.checkNode(),
      Doctor.checkGit(),
      Doctor.checkDiskSpace(),
      Doctor.checkPlatform(),
    ])

    checks.push(platformCheck, nodeCheck, gitCheck)

    // API Key 检查
    checks.push(Doctor.checkApiKey(opts.apiKeyConfigured, opts.provider, opts.model))

    // MCP 连接检查
    if (opts.mcpManager) {
      checks.push(await Doctor.checkMCP(opts.mcpManager))
    }

    checks.push(diskCheck)

    return checks
  }

  private static checkPlatform(): DoctorCheck {
    return {
      name: 'Platform',
      status: 'ok',
      message: `${os.type()} ${os.release()} (${os.arch()}, ${os.cpus().length} cores, ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)}GB RAM)`,
    }
  }

  private static async checkNode(): Promise<DoctorCheck> {
    const version = process.version
    const major = parseInt(version.slice(1).split('.')[0], 10)
    if (major >= 20) {
      return { name: 'Node.js', status: 'ok', message: version }
    }
    return {
      name: 'Node.js',
      status: 'warn',
      message: `${version} (recommended: >= 20.0.0)`,
      fix: 'Upgrade Node.js to v20+ for best compatibility',
    }
  }

  private static async checkGit(): Promise<DoctorCheck> {
    return new Promise((resolve) => {
      exec('git --version', { timeout: 5000 }, (err, stdout) => {
        if (err) {
          return resolve({
            name: 'Git',
            status: 'error',
            message: 'Not found',
            fix: 'Install Git from https://git-scm.com',
          })
        }
        const version = stdout.trim().replace('git version ', '')
        resolve({ name: 'Git', status: 'ok', message: version })
      })
    })
  }

  private static checkApiKey(configured: boolean, provider: string, model: string): DoctorCheck {
    if (configured) {
      return {
        name: 'API Key',
        status: 'ok',
        message: `${provider} / ${model} — key configured`,
      }
    }
    return {
      name: 'API Key',
      status: 'error',
      message: `No API key for ${provider}`,
      fix: 'Go to Settings → Model & Provider to configure your API key',
    }
  }

  private static async checkMCP(mcpManager: MCPManager): Promise<DoctorCheck> {
    try {
      const servers = await mcpManager.listServers()
      const connected = servers.filter(s => s.connected).length
      const total = servers.length

      if (total === 0) {
        return { name: 'MCP Servers', status: 'ok', message: 'No MCP servers configured' }
      }
      if (connected === total) {
        return { name: 'MCP Servers', status: 'ok', message: `${connected}/${total} connected` }
      }
      const disconnected = servers.filter(s => !s.connected).map(s => s.name).join(', ')
      return {
        name: 'MCP Servers',
        status: 'warn',
        message: `${connected}/${total} connected (disconnected: ${disconnected})`,
        fix: 'Check MCP server logs for connection errors',
      }
    } catch (err) {
      return {
        name: 'MCP Servers',
        status: 'warn',
        message: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  private static async checkDiskSpace(): Promise<DoctorCheck> {
    try {
      const homeDir = os.homedir()
      // 检查 userData 目录所在磁盘的可用空间
      return new Promise((resolve) => {
        const cmd = process.platform === 'win32'
          ? `wmic logicaldisk where "DeviceID='${homeDir.charAt(0)}:'" get FreeSpace /value`
          : `df -h "${homeDir}" | tail -1 | awk '{print $4}'`

        exec(cmd, { timeout: 5000 }, (err: Error | null, stdout: string) => {
          if (err) {
            return resolve({ name: 'Disk Space', status: 'ok', message: 'Unable to check' })
          }

          if (process.platform === 'win32') {
            const match = stdout.match(/FreeSpace=(\d+)/)
            if (match) {
              const gb = parseInt(match[1], 10) / 1024 / 1024 / 1024
              if (gb < 1) {
                return resolve({
                  name: 'Disk Space',
                  status: 'error',
                  message: `${gb.toFixed(1)}GB free`,
                  fix: 'Free up disk space — less than 1GB remaining',
                })
              }
              if (gb < 10) {
                return resolve({
                  name: 'Disk Space',
                  status: 'warn',
                  message: `${gb.toFixed(1)}GB free`,
                  fix: 'Consider freeing up disk space',
                })
              }
              return resolve({ name: 'Disk Space', status: 'ok', message: `${gb.toFixed(1)}GB free` })
            }
          } else {
            const free = stdout.trim()
            return resolve({ name: 'Disk Space', status: 'ok', message: `${free} free` })
          }

          resolve({ name: 'Disk Space', status: 'ok', message: 'Available' })
        })
      })
    } catch {
      return { name: 'Disk Space', status: 'ok', message: 'Unable to check' }
    }
  }

  /**
   * 格式化诊断结果为 Markdown
   */
  static formatResults(checks: DoctorCheck[]): string {
    const statusIcon = (s: string) => s === 'ok' ? '✓' : s === 'warn' ? '⚠' : '✗'
    const lines = checks.map(c => {
      let line = `${statusIcon(c.status)} **${c.name}**: ${c.message}`
      if (c.fix) line += `\n  → _${c.fix}_`
      return line
    })
    return `## wzxClaw Doctor\n\n${lines.join('\n\n')}`
  }
}
