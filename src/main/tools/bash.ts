import { z } from 'zod'
import { exec } from 'child_process'
import { MAX_TOOL_RESULT_CHARS } from '../../shared/constants'
import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'

// ============================================================
// Bash Tool (per TOOL-04, D-32, D-36)
// ============================================================

const DEFAULT_TIMEOUT = 30000 // 30 seconds per D-36

const BashSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().positive().optional()
})

export class BashTool implements Tool {
  readonly name = 'Bash'
  readonly description =
    'Execute a shell command and return stdout and stderr output. Commands run in the working directory.'
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

    return new Promise<ToolExecutionResult>((resolve) => {
      const child = exec(
        command,
        {
          cwd: context.workingDirectory,
          timeout: effectiveTimeout,
          maxBuffer: 1024 * 1024
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
        }
      )

      // Handle abort signal
      if (context.abortSignal) {
        const onAbort = (): void => {
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
