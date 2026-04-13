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
  workingDirectory: string
}): string {
  const { model, provider, workingDirectory } = options

  // Resolve human-readable model name
  const preset = DEFAULT_MODELS.find((m) => m.id === model)
  const modelName = preset ? preset.name : model

  // Platform info
  const platform = os.platform()
  const osVersion = `${os.type()} ${os.release()}`

  // Git repo check
  const isGitRepo = fs.existsSync(path.join(workingDirectory, '.git'))

  // Current date
  const date = new Date().toISOString().slice(0, 10)

  const lines = [
    '## Environment',
    ` - Working directory: ${workingDirectory}`,
    ` - Is git repo: ${isGitRepo}`,
    ` - Platform: ${platform}`,
    ` - OS: ${osVersion}`,
    ` - Shell: ${platform === 'win32' ? 'bash (use Unix shell syntax, not Windows — e.g., forward slashes in paths)' : os.userInfo().shell || '/bin/sh'}`,
    ` - You are powered by the model ${modelName} (model ID: ${model}, provider: ${provider}).`,
    ` - Current date: ${date}`,
  ]

  return lines.join('\n')
}
