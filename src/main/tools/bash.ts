import { z } from 'zod'
import { exec } from 'child_process'
import { existsSync, appendFile } from 'fs'
import path from 'path'
import { MAX_TOOL_RESULT_CHARS } from '../../shared/constants'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import type { TerminalManager } from '../terminal/terminal-manager'
import { analyzeBashCommand } from './bash-security'
import { isReadOnlyBashCommand } from './bash-readonly'
import { getShellSnapshotsDir } from '../paths'

// ============================================================
// Bash Tool (per TOOL-04, D-32, D-36)
// ============================================================

const DEFAULT_TIMEOUT = 30000 // 30 seconds per D-36

// Detect Git Bash on Windows for better Unix command compatibility
let detectedShell: string | undefined
if (process.platform === 'win32') {
  const gitBashPaths = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ]
  for (const p of gitBashPaths) {
    if (p && existsSync(p)) {
      detectedShell = p
      break
    }
  }
}

const BashSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().positive().optional()
})

export class BashTool implements Tool {
  readonly name = 'Bash'
  readonly description = `Execute a shell command and return stdout and stderr output. Commands run in the working directory.

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
    const security = analyzeBashCommand(command)
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
      if (process.platform === 'win32' && !useGitBash) {
        commandToRun = `chcp 65001 > nul 2>&1 && ${command}`
      }

      const child = exec(
        commandToRun,
        {
          cwd: context.workingDirectory,
          timeout: effectiveTimeout,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
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

          let output = stdout || ''
          if (stderr) {
            output += (output ? '\nSTDERR:\n' : 'STDERR:\n') + stderr
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
