// ============================================================
// Prompt Shell Execution — execute !`cmd` and ```! blocks in skills
// Runs embedded shell commands and replaces them with output
// ============================================================

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// Pattern for code blocks: ```! command ```
const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g

// Pattern for inline: !`command`
// Uses lookbehind to require whitespace or start-of-line before !
const INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm

export interface ShellExecutionOptions {
  cwd?: string
  timeout?: number
  shell?: 'bash' | 'powershell'
}

/**
 * Parses prompt text and executes any embedded shell commands.
 * Supports two syntaxes:
 *
 * 1. Inline: !`command` — replaced with stdout
 * 2. Block:
 *    ```!
 *    command
 *    ```
 *    — replaced with stdout
 *
 * Security: only executed for trusted sources (user/bundled/project).
 * Plugin-sourced skills from untrusted origins are skipped.
 */
const TRUSTED_SOURCES = new Set(['user', 'bundled', 'project', 'managed'])

export async function executeShellCommandsInPrompt(
  content: string,
  options: ShellExecutionOptions = {},
  source?: string,
): Promise<string> {
  // Skip shell execution for untrusted sources
  if (source && !TRUSTED_SOURCES.has(source)) {
    return content
  }

  // Quick check: skip if no shell patterns present
  if (!content.includes('!`') && !content.includes('```!')) {
    return content
  }

  let result = content

  // Execute block patterns first (```! ... ```)
  result = await executePatterns(result, BLOCK_PATTERN, options)

  // Then execute inline patterns (!`...`)
  result = await executePatterns(result, INLINE_PATTERN, options)

  return result
}

async function executePatterns(
  content: string,
  pattern: RegExp,
  options: ShellExecutionOptions,
): Promise<string> {
  const matches: Array<{ match: string; command: string; index: number }> = []
  let match: RegExpExecArray | null

  const regex = new RegExp(pattern.source, pattern.flags)
  while ((match = regex.exec(content)) !== null) {
    matches.push({
      match: match[0],
      command: (match[1] ?? '').trim(),
      index: match.index,
    })
  }

  if (matches.length === 0) return content

  // Execute commands in parallel
  const results = await Promise.all(
    matches.map(async ({ command }) => {
      try {
        const shell = options.shell ?? 'bash'
        const isPowershell = shell === 'powershell'
        const { stdout } = await execFileAsync(
          isPowershell ? 'powershell' : 'bash',
          isPowershell ? ['-NoProfile', '-Command', command] : ['-c', command],
          {
            cwd: options.cwd,
            timeout: options.timeout ?? 30000,
            maxBuffer: 1024 * 1024,
          },
        )
        return stdout.trim()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[skills] Shell command failed: ${command}\n  ${msg}`)
        return `[shell error: ${msg}]`
      }
    }),
  )

  // Replace matches in reverse order to preserve indices
  let result = content
  for (let i = matches.length - 1; i >= 0; i--) {
    const { match } = matches[i]!
    const output = results[i]!
    result = result.replace(match, output)
  }

  return result
}
