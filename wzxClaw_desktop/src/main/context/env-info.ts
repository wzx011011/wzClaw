// ============================================================
// Environment Info — Runtime context injected into system prompt
// ============================================================

import os from 'os'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { DEFAULT_MODELS } from '../../shared/constants'
import { getScratchpadDir } from '../paths'

// 缓存 shell 检测结果（bash.exe 路径不会频繁变化）
let cachedShellInfo: string | null = null
// 缓存 git repo 检测结果（key: primaryRoot）
const gitRepoCache = new Map<string, boolean>()

/**
 * Detect available shell (cached after first call).
 */
function detectShellInfo(): string {
  if (cachedShellInfo !== null) return cachedShellInfo

  const platform = os.platform()
  if (platform === 'win32') {
    let hasGitBash = false
    if (process.env.WZXCLAW_GIT_BASH_PATH && fs.existsSync(process.env.WZXCLAW_GIT_BASH_PATH)) {
      hasGitBash = true
    } else {
      try {
        const whereOutput = execSync('where.exe git', { encoding: 'utf-8', timeout: 5000 }).trim()
        const candidates = whereOutput.split('\n').map((l: string) => l.trim().replace(/\r$/, '')).filter(Boolean)
        for (const gitPath of candidates) {
          if (!fs.existsSync(gitPath)) continue
          const gitDir = path.dirname(gitPath)
          const bashCandidates = [
            path.join(gitDir, '..', 'bin', 'bash.exe'),
            path.join(gitDir, 'bash.exe'),
          ]
          if (bashCandidates.some((p) => fs.existsSync(path.resolve(p)))) {
            hasGitBash = true
            break
          }
        }
      } catch { /* where git failed */ }
      if (!hasGitBash) {
        const fallbacks = [
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
          path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
        ]
        hasGitBash = fallbacks.some((p) => p && fs.existsSync(p))
      }
    }
    cachedShellInfo = hasGitBash
      ? 'bash (use Unix shell syntax, not Windows — e.g., /dev/null not NUL, forward slashes in paths)'
      : 'cmd.exe — Unix commands NOT available. Prefer Glob/Grep/FileRead over shell commands.'
  } else {
    cachedShellInfo = os.userInfo().shell || '/bin/sh'
  }
  return cachedShellInfo
}

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
  const primaryRoot = projectRoots[0] ?? process.cwd()

  // Resolve human-readable model name
  const preset = DEFAULT_MODELS.find((m) => m.id === model)
  const modelName = preset ? preset.name : model

  // Platform info
  const platform = os.platform()
  const osVersion = `${os.type()} ${os.release()}`

  // Git repo check on primary root (cached)
  let isGitRepo = gitRepoCache.get(primaryRoot)
  if (isGitRepo === undefined) {
    isGitRepo = fs.existsSync(path.join(primaryRoot, '.git'))
    gitRepoCache.set(primaryRoot, isGitRepo)
  }

  // Current date
  const date = new Date().toISOString().slice(0, 10)

  // Shell info (cached after first call)
  const shellInfo = detectShellInfo()

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
    ` - Scratchpad: ${getScratchpadDir()} (use for temporary files)`,
  )

  return lines.join('\n')
}
