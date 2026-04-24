// ============================================================
// Environment Info — Runtime context injected into system prompt
// ============================================================

import os from 'os'
import fs from 'fs'
import path from 'path'
import { DEFAULT_MODELS } from '../../shared/constants'

/**
 * Build runtime environment section for the system prompt.
 * Provides model identity, platform, CWD, and date so the LLM
 * can answer identity/environment questions without tool calls.
 */
export function buildEnvInfo(options: {
  model: string
  provider: string
  projectRoots: string[]
}): string {
  const { model, provider, projectRoots } = options
  const primaryRoot = projectRoots[0]

  // Resolve human-readable model name
  const preset = DEFAULT_MODELS.find((m) => m.id === model)
  const modelName = preset ? preset.name : model

  // Platform info
  const platform = os.platform()
  const osVersion = `${os.type()} ${os.release()}`

  // Git repo check on primary root
  const isGitRepo = fs.existsSync(path.join(primaryRoot, '.git'))

  // Current date
  const date = new Date().toISOString().slice(0, 10)

  // Determine the actual shell so the model uses correct syntax and commands.
  // On Windows we check for Git Bash first; without it the shell is cmd.exe.
  let shellInfo: string
  if (platform === 'win32') {
    const gitBashCandidates = [
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
    ]
    const hasGitBash = gitBashCandidates.some((p) => p && fs.existsSync(p))
    if (hasGitBash) {
      shellInfo =
        'Git Bash — Unix commands (find, grep, head, tail, etc.) are available. Use forward-slash paths.'
    } else {
      shellInfo =
        'cmd.exe (Windows) — Unix commands such as find, head, grep, ls are NOT available. ' +
        'Use Windows-compatible paths (e.g. E:\\path or E:/path, NOT /e/path). ' +
        'Prefer the Glob/Grep/FileRead tools over shell commands whenever possible.'
    }
  } else {
    shellInfo = os.userInfo().shell || '/bin/sh'
  }

  const lines = [
    '## Environment',
    ` - Working directory: ${primaryRoot}`,
  ]

  // List all project roots for multi-project tasks
  if (projectRoots.length > 1) {
    lines.push(` - Project roots (${projectRoots.length}):`)
    for (let i = 0; i < projectRoots.length; i++) {
      const label = i === 0 ? ' (primary)' : ''
      lines.push(`   ${i + 1}. ${path.basename(projectRoots[i])}: \`${projectRoots[i]}\`${label}`)
    }
  }

  lines.push(
    ` - Is git repo: ${isGitRepo}`,
    ` - Platform: ${platform}`,
    ` - OS: ${osVersion}`,
    ` - Shell: ${shellInfo}`,
    ` - You are powered by the model ${modelName} (model ID: ${model}, provider: ${provider}).`,
    ` - Current date: ${date}`,
  )

  return lines.join('\n')
}
