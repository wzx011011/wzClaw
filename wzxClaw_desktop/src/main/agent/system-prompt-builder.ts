// ============================================================
// SystemPromptBuilder — 构建系统提示（静态 + 动态分离）
// 从 AgentLoop.run() 中提取，独立测试和复用
// ============================================================

import type { LLMProvider, Workspace } from '../../shared/types'
import type { AgentConfig } from './types'
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from '../../shared/constants'
import { getGitContext } from '../git/git-context'
import { loadInstructionSections } from '../context/instruction-loader'
import { buildEnvInfo } from '../context/env-info'
import { MemoryManager } from '../memory/memory-manager'
import { countTokens } from '../context/token-counter'

export interface SystemPromptResult {
  /** 完整系统提示（含缓存边界） */
  systemPrompt: string
  /** 工具定义（从 ToolRegistry 获取，不在 prompt 文本中） */
}

export interface SystemPromptBreakdown {
  /** 完整系统提示（含缓存边界） */
  systemPrompt: string
  /** 静态部分 token 数 (CACHE_BOUNDARY 之前) */
  staticTokens: number
  /** 环境信息 token 数 */
  envInfoTokens: number
  /** Git 上下文 token 数 */
  gitContextTokens: number
  /** WZXCLAW.md + rules token 数 */
  instructionsTokens: number
  /** 用户命令 token 数 */
  commandsTokens: number
  /** 用户技能 token 数 */
  skillsTokens: number
  /** MEMORY.md 部分 token 数 */
  memoryTokens: number
  /** 活跃工作区上下文 token 数 */
  taskContextTokens: number
  /** 所有动态部分 token 总数 */
  dynamicTokens: number
}

/**
 * Build system prompt with per-segment token counts.
 */
export async function buildSystemPromptBreakdown(
  config: Pick<AgentConfig, 'systemPrompt' | 'workingDirectory' | 'projectRoots' | 'model' | 'provider'>,
  activeTask?: Workspace | null
): Promise<SystemPromptBreakdown> {
  const roots = config.projectRoots ?? [config.workingDirectory]

  // Load all dynamic context segments in parallel
  const [gitContext, instructionSections, memorySection] = await Promise.all([
    getGitContext(roots).catch(() => ''),
    loadInstructionSections(roots).catch(() => ({ instructions: '', commands: '', skills: '', merged: '' })),
    new MemoryManager(roots[0]).buildSystemPromptSection().catch(() => ''),
  ])

  const envInfo = buildEnvInfo({
    model: config.model,
    provider: config.provider,
    projectRoots: roots,
  })

  const taskContext = activeTask ? buildTaskContext(activeTask) : ''

  // Count tokens per segment
  const staticTokens = countTokens(config.systemPrompt ?? '')
  const envInfoTokens = countTokens(envInfo)
  const gitContextTokens = countTokens(gitContext)
  const instructionsTokens = countTokens(instructionSections.instructions)
  const commandsTokens = countTokens(instructionSections.commands)
  const skillsTokens = countTokens(instructionSections.skills)
  const memoryTokens = countTokens(memorySection)
  const taskContextTokens = countTokens(taskContext)

  // Merge instructions section (commands + skills are part of it via merged)
  const mergedInstructions = instructionSections.merged
  const dynamicParts: string[] = [envInfo]
  if (gitContext) dynamicParts.push(gitContext)
  if (mergedInstructions) dynamicParts.push(mergedInstructions)
  if (memorySection) dynamicParts.push(memorySection)
  if (taskContext) dynamicParts.push(taskContext)

  const dynamicTokens = envInfoTokens + gitContextTokens
    + countTokens(mergedInstructions)
    + memoryTokens + taskContextTokens

  const systemPrompt = config.systemPrompt + SYSTEM_PROMPT_CACHE_BOUNDARY + dynamicParts.join('\n\n')

  return {
    systemPrompt,
    staticTokens,
    envInfoTokens,
    gitContextTokens,
    instructionsTokens,
    commandsTokens,
    skillsTokens,
    memoryTokens,
    taskContextTokens,
    dynamicTokens,
  }
}

/**
 * 构建带缓存边界的系统提示。
 *
 * 结构：
 *   [静态部分] config.systemPrompt
 *   <!-- CACHE_BOUNDARY -->
 *   [动态部分] env + git + instructions + memory
 *
 * 静态部分跨会话不变，可被 Anthropic prompt caching 缓存；
 * 动态部分每会话可能变化。
 */
export async function buildSystemPrompt(
  config: Pick<AgentConfig, 'systemPrompt' | 'workingDirectory' | 'projectRoots' | 'model' | 'provider'>,
  activeTask?: Workspace | null
): Promise<string> {
  const breakdown = await buildSystemPromptBreakdown(config, activeTask)
  return breakdown.systemPrompt
}

function buildTaskContext(task: Workspace): string {
  const lines: string[] = ['# Active Task']
  lines.push(`**${task.title}**`)
  if (task.description) lines.push(task.description)
  if (task.projects.length > 0) {
    lines.push('')
    lines.push('## Mounted Projects')
    for (const p of task.projects) {
      lines.push(`- ${p.name}: \`${p.path}\``)
    }
  }
  return lines.join('\n')
}
