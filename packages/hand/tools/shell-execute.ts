// ============================================================
// ShellExecute 工具 — 在 Docker 容器中执行 shell 命令
// 支持：超时限制、安全黑名单、工作目录指定
// ============================================================

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { HandTool } from '../src/tool-executor.js'
import { assertPathInWorkspace } from '../src/path-guard.js'

const execAsync = promisify(exec)

/** 默认超时时间（30 秒） */
const DEFAULT_TIMEOUT_SECONDS = 30

/** 默认工作目录（NAS 挂载卷） */
const DEFAULT_CWD = '/data'

/**
 * 危险命令黑名单模式
 *
 * 匹配以下类型的危险命令:
 * - rm -rf / (递归删除根目录)
 * - mkfs (格式化文件系统)
 * - dd if= (直接磁盘写入)
 * - :(){ :|:& };: (fork bomb)
 * - format (格式化)
 * - del /s (Windows 递归删除)
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // 递归删除关键路径（根、家目录、系统目录、数据卷）
  { pattern: /\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+(\/|~|\$HOME|\/\*|\/etc|\/usr|\/var|\/home|\/root|\/bin|\/sbin|\/boot|\/lib|\/opt|\/data)(\s|$|\/)/, description: 'rm -rf 递归删除系统/数据目录' },
  { pattern: /mkfs/, description: 'mkfs — 格式化文件系统' },
  { pattern: /\bdd\s+if=/, description: 'dd if= — 直接磁盘写入' },
  { pattern: /:\(\)\{\s*:\|:&\s*\};\s*:/, description: 'fork bomb — 进程炸弹' },
  { pattern: /\bformat\b/, description: 'format — 格式化' },
  { pattern: /\bdel\s+\/s/i, description: 'del /s — 递归删除' },
  // 从网络下载后直接执行（供应链攻击常见手法）
  { pattern: /\b(curl|wget|fetch)\s+[^|;]*[|;]\s*(bash|sh|zsh|ksh|python|node|perl)\b/, description: 'curl|sh — 下载即执行' },
  // 重定向覆盖裸块设备
  { pattern: />\s*\/dev\/sd[a-z]/, description: '重定向裸块设备' },
  // 全局 chmod/chown 递归修改根
  { pattern: /\bchmod\s+(-[a-zA-Z]*[Rr][a-zA-Z]*\s+)?[0-9]+\s+\/(\s|$)/, description: 'chmod 修改根目录权限' },
  { pattern: /\bchown\s+(-[a-zA-Z]*[Rr][a-zA-Z]*\s+)?[^\s]+\s+\/(\s|$)/, description: 'chown 修改根目录拥有者' },
  // shutdown/reboot/halt
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, description: '系统关机/重启命令' },
]

/**
 * ShellExecuteTool — 在容器中执行 shell 命令
 *
 * 功能:
 * - 执行 shell 命令，返回 {stdout, stderr, exitCode}
 * - 默认 30 秒超时
 * - 默认工作目录 /data（NAS 挂载卷）
 * - 危险命令黑名单检查，阻止容器级破坏
 */
export class ShellExecuteTool implements HandTool {
  readonly name = 'ShellExecute'
  readonly description = '在容器中执行 shell 命令，有超时和安全限制'
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      timeout: { type: 'number', description: '超时秒数（默认 30）' },
      cwd: { type: 'string', description: '工作目录（默认 /data）' },
    },
    required: ['command'],
  }
  readonly isReadOnly = false

  async execute(
    input: Record<string, unknown>,
    context: { workingDirectory: string; projectRoots: string[] },
  ): Promise<{ output: string; isError: boolean }> {
    // 校验必需参数
    const command = input.command
    if (typeof command !== 'string' || command.length === 0) {
      return { output: '缺少 command 参数', isError: true }
    }

    // 安全检查：匹配危险命令黑名单
    for (const { pattern, description } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return {
          output: `禁止执行危险命令: ${description}`,
          isError: true,
        }
      }
    }

    // 解析参数
    const timeoutSeconds = typeof input.timeout === 'number' && input.timeout > 0
      ? input.timeout
      : DEFAULT_TIMEOUT_SECONDS
    const requestedCwd = typeof input.cwd === 'string' && input.cwd.length > 0
      ? input.cwd
      : DEFAULT_CWD

    // cwd 必须是绝对路径
    const isAbsolute = requestedCwd.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(requestedCwd)
    if (!isAbsolute) {
      return { output: `cwd 必须为绝对路径: ${requestedCwd}`, isError: true }
    }

    // 路径白名单校验：cwd 必须在 workspace 内，或在 DEFAULT_CWD (/data) 子树
    // DEFAULT_CWD 作为兜底白名单，兼容无 workspace 配置的 chat:send 场景
    const violation = assertPathInWorkspace(requestedCwd, context, [DEFAULT_CWD])
    if (violation) return violation

    const cwd = requestedCwd

    try {
      const timeoutMs = timeoutSeconds * 1000
      const { stdout, stderr } = await execAsync(command, {
        timeout: timeoutMs,
        cwd,
        // killSignal 默认 SIGTERM
        // 注：Docker Alpine 环境默认使用 /bin/sh，Windows 开发环境使用 cmd.exe
      })

      return {
        output: JSON.stringify({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: 0,
        }),
        isError: false,
      }
    } catch (err: unknown) {
      // execAsync 抛出异常时包含 Code, stdout, stderr
      const execErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean }

      // 命令超时
      if (execErr.killed) {
        return {
          output: JSON.stringify({
            stdout: execErr.stdout || '',
            stderr: (execErr.stderr || '') + `\nCommand timed out after ${timeoutSeconds}s`,
            exitCode: execErr.code ?? -1,
          }),
          isError: false,
        }
      }

      // 命令执行失败（非零退出码）
      return {
        output: JSON.stringify({
          stdout: execErr.stdout || '',
          stderr: execErr.stderr || '',
          exitCode: typeof execErr.code === 'number' ? execErr.code : -1,
        }),
        isError: false,
      }
    }
  }
}
