import { z } from 'zod'
import { exec, execSync } from 'child_process'
import { existsSync, appendFile } from 'fs'
import path from 'path'
import iconv from 'iconv-lite'
import { MAX_TOOL_RESULT_CHARS } from '../../shared/constants'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import type { TerminalManager } from '../terminal/terminal-manager'
import { analyzeBashCommand } from './bash-security'
import { getShellSnapshotsDir } from '../paths'

// ============================================================
// Bash Tool — 对齐 Claude Code 的 Windows 策略：
//   1. 通过 where git → 推导 bash.exe 位置（覆盖所有安装方式）
//   2. 自动重写 >nul → /dev/null（防止 Git Bash 创建 NUL 文件）
//   3. 始终使用 bash（POSIX），消除 Unix/Windows 命令兼容问题
// ============================================================

const DEFAULT_TIMEOUT = 30000 // 30 seconds per D-36

/**
 * Windows 上查找 Git Bash — 对齐 Claude Code 检测策略：
 *   1. 环境变量 WZXCLAW_GIT_BASH_PATH
 *   2. where git → 从 git.exe 位置推导 bash.exe
 *   3. 硬编码常见路径（兜底）
 */
function findGitBashOnWindows(): string | undefined {
  if (process.platform !== 'win32') return undefined

  // Step 1: 环境变量覆盖
  const envPath = process.env.WZXCLAW_GIT_BASH_PATH
  if (envPath && existsSync(envPath)) return envPath

  // Step 2: 通过 where git 查找 git.exe → 推导 bash.exe（Claude Code 主策略）
  try {
    const whereOutput = execSync('where.exe git', { encoding: 'utf-8', timeout: 5000 }).trim()
    const gitCandidates = whereOutput.split('\n').map(l => l.trim().replace(/\r$/, '')).filter(Boolean)
    for (const gitPath of gitCandidates) {
      if (!existsSync(gitPath)) continue
      // git.exe 通常在 Git\cmd\ 或 Git\bin\ 下；bash.exe 在 Git\bin\ 下
      // Git\cmd\git.exe → ..\..\bin\bash.exe = Git\bin\bash.exe
      // Git\bin\git.exe → ..\bin\bash.exe → 不存在；直接取 Git\bin\bash.exe
      const gitDir = path.dirname(gitPath)
      const possibleBashPaths = [
        path.join(gitDir, '..', 'bin', 'bash.exe'),   // cmd/git.exe → bin/bash.exe
        path.join(gitDir, 'bash.exe'),                  // bin/git.exe → bin/bash.exe
      ]
      for (const bashPath of possibleBashPaths) {
        const resolved = path.resolve(bashPath)
        if (existsSync(resolved)) return resolved
      }
    }
  } catch {
    // where git 失败 — git 不在 PATH 中
  }

  // Step 3: 硬编码常见安装路径（兜底）
  const hardcodedPaths = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ]
  for (const p of hardcodedPaths) {
    if (p && existsSync(p)) return p
  }

  return undefined
}

let detectedShell: string | undefined = findGitBashOnWindows()

/**
 * Claude Code 的 >nul → /dev/null 自动重写。
 * LLM 有时在 Git Bash 环境下写出 `2>nul` 等 CMD 语法，
 * Git Bash 会创建名为 NUL 的文件（Windows 保留设备名），导致 git 报错。
 * 参考：anthropics/claude-code#4928
 */
function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(/(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g, '$1/dev/null')
}

const BashSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().positive().optional()
})

export class BashTool implements Tool {
  readonly name = 'Bash'

  get description(): string {
    // 对齐 Claude Code：根据实际检测到的 shell 提示语法风格
    const shellNote =
      process.platform === 'win32'
        ? detectedShell
          ? '\n\nShell: bash (use Unix shell syntax, not Windows — e.g., /dev/null not NUL, forward slashes in paths).'
          : '\n\nShell: cmd.exe — Unix commands are NOT available. Prefer Glob/Grep/FileRead tools over shell commands. Use forward-slash or backslash paths.'
        : ''
    return `Execute a shell command and return stdout and stderr output. Commands run in the working directory.${shellNote}

IMPORTANT: Do NOT use Bash when a dedicated tool exists:
- To read files: use FileRead (not cat/head/tail)
- To edit files: use FileEdit (not sed/awk)
- To search files by name: use Glob (not find/ls)
- To search file contents: use Grep (not grep/rg)
Reserve Bash for system commands: git, npm, build tools, process management, etc.

When running git commands:
- Never use --no-verify or skip hooks unless explicitly asked.
- Never force push to main/master.
- Never use interactive flags (-i) as they require terminal input.
- Prefer creating new commits over amending existing ones.
- Before destructive operations (reset --hard, push --force), confirm with the user.

Always quote file paths containing spaces with double quotes.`
  }
  readonly requiresApproval = true
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute'
      },
      timeout: {
        type: 'number',
        description: `Timeout in milliseconds (default: ${DEFAULT_TIMEOUT})`
      }
    },
    required: ['command']
  }

  private terminalManager?: TerminalManager

  constructor(_workingDirectory: string, terminalManager?: TerminalManager) {
    this.terminalManager = terminalManager
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const parsed = BashSchema.safeParse(input)
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0] ?? 'input'
      return {
        output: `Invalid input: ${field} is required`,
        isError: true
      }
    }

    const { command, timeout } = parsed.data
    const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT

    // Security analysis — block dangerous commands before execution
    const shellIsUnix = process.platform !== 'win32' || !!detectedShell
    const security = analyzeBashCommand(command, shellIsUnix)
    if (security.blocked) {
      return {
        output: `Command blocked: ${security.reason}`,
        isError: true
      }
    }

    // Log security warnings if any
    if (security.warnings.length > 0) {
      console.warn(`[BashTool] Security warnings for command "${command}":`, security.warnings)
    }

    // Security audit trail: log every executed command for visibility
    console.log(`[BashTool] Executing command: ${command}`)

    // Persist to shell-snapshots (fire-and-forget, daily file)
    const today = new Date().toISOString().slice(0, 10)
    const snapshotFile = path.join(getShellSnapshotsDir(), `history-${today}.sh`)
    const snapshotLine = `# ${new Date().toISOString()} cwd=${context.workingDirectory}\n${command}\n`
    appendFile(snapshotFile, snapshotLine, 'utf-8', () => {/* ignore */})

    // Route through visible terminal when TerminalManager and active terminal exist (per TERM-04)
    if (this.terminalManager) {
      const activeId = this.terminalManager.getActiveTerminalId()
      if (activeId) {
        try {
          const output = await this.terminalManager.runCommandInTerminal(activeId, command)
          const truncated = output.length > MAX_TOOL_RESULT_CHARS
            ? output.substring(0, MAX_TOOL_RESULT_CHARS) + '\n... [output truncated]'
            : output
          return { output: truncated, isError: false }
        } catch (err) {
          // Fall through to child_process.exec on terminal error
          console.warn('Terminal routing failed, falling back to exec:', err)
        }
      }
    }

    return new Promise<ToolExecutionResult>((resolve) => {
      // On Windows with Git Bash: use bash directly for Unix command compatibility.
      // Without Git Bash: force UTF-8 codepage so cmd.exe error messages aren't GBK-garbled.
      let commandToRun = command
      const useGitBash = process.platform === 'win32' && detectedShell
      // 对齐 Claude Code：仅在 Git Bash 下重写 >nul → /dev/null（cmd.exe 不支持 /dev/null）
      if (useGitBash) {
        commandToRun = rewriteWindowsNullRedirect(command)
      }
      if (process.platform === 'win32' && !useGitBash) {
        commandToRun = `chcp 65001 > nul 2>&1 && ${commandToRun}`
      }

      // On Windows cmd.exe: use buffer encoding + iconv-lite to avoid GBK mojibake.
      // Git Bash outputs UTF-8 natively, so 'utf8' is fine there.
      const isWindowsCmd = process.platform === 'win32' && !useGitBash
      const child = exec(
        commandToRun,
        {
          cwd: context.workingDirectory,
          timeout: effectiveTimeout,
          maxBuffer: 1024 * 1024,
          encoding: isWindowsCmd ? 'buffer' : 'utf8',
          shell: useGitBash ? detectedShell : undefined,
          env: process.platform === 'win32'
            ? { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
            : process.env
        },
        (error, stdout, stderr) => {
          if (context.abortSignal?.aborted) {
            resolve({
              output: 'Command aborted',
              isError: true
            })
            return
          }

          // Decode from GBK on Windows cmd.exe, UTF-8 elsewhere
          const decode = (buf: Buffer | string): string => {
            if (typeof buf === 'string') return buf
            // Try UTF-8 first, fall back to GBK if it contains replacement chars
            const utf8 = buf.toString('utf8')
            if (buf.length < 2 || !utf8.includes('\ufffd')) return utf8
            return iconv.decode(buf, 'gbk')
          }

          let output = decode(stdout as Buffer | string) || ''
          const stderrText = decode(stderr as Buffer | string)
          if (stderrText) {
            output += (output ? '\nSTDERR:\n' : 'STDERR:\n') + stderrText
          }

          // Truncate at MAX_TOOL_RESULT_CHARS
          if (output.length > MAX_TOOL_RESULT_CHARS) {
            output = output.substring(0, MAX_TOOL_RESULT_CHARS) + '\n... [output truncated]'
          }

          const isError = error !== null
          if (isError && !output) {
            output = error.message
          }

          resolve({ output, isError })

          // Clean up abort listener to prevent memory leak
          if (onAbort && context.abortSignal) {
            context.abortSignal.removeEventListener('abort', onAbort)
          }
        }
      )

      // Handle abort signal
      let onAbort: (() => void) | null = null
      if (context.abortSignal) {
        onAbort = (): void => {
          child.kill()
        }
        if (context.abortSignal.aborted) {
          child.kill()
        } else {
          context.abortSignal.addEventListener('abort', onAbort, { once: true })
        }
      }
    })
  }
}
