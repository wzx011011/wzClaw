// ============================================================
// SystemPromptBuilder — 构建系统提示（静态 + 动态分离）
// 从 AgentLoop.run() 中提取，独立测试和复用
// ============================================================

import type { Workspace } from '../../shared/types'
import type { AgentConfig } from './types'
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from '../../shared/constants'
import { getGitContext } from '../git/git-context'
import { loadInstructionSections } from '../context/instruction-loader'
import { buildEnvInfo } from '../context/env-info'
import { MemoryManager } from '../memory/memory-manager'
import { countTokens } from '../context/token-counter'

// ============================================================
// Plan Mode System Prompt — 5-stage workflow instructions
// ============================================================

const PLAN_MODE_INSTRUCTIONS = `
<plan_mode>
You are currently in PLANNING MODE. Follow this 5-stage workflow:

1. **READ** — Thoroughly read and analyze all relevant files and code before proposing any changes. Use FileRead, Grep, Glob, and other read-only tools freely.

2. **ANALYZE** — Identify the root cause, dependencies, and potential impact of changes. Consider edge cases and existing patterns.

3. **PLAN** — Formulate a concrete, step-by-step implementation plan. Each step should be specific and actionable.

4. **DOCUMENT** — When your analysis is complete, call ExitPlanMode with a markdown plan describing:
   - What changes you will make and why
   - The specific files and functions affected
   - The order of implementation
   - Any risks or trade-offs

5. **EXECUTE** — After the user approves your plan, write operations will be unblocked and you may proceed with implementation.

IMPORTANT:
- Do NOT make any file changes (FileWrite, FileEdit, Bash) while in plan mode.
- Focus on understanding the codebase thoroughly before proposing changes.
- Be specific in your plan — vague plans will be rejected.
</plan_mode>
`

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
  activeWorkspace?: Workspace | null,
  planModeActive?: boolean
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

  const taskContext = activeWorkspace ? buildWorkspaceContext(activeWorkspace) : ''

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
  if (planModeActive) dynamicParts.push(PLAN_MODE_INSTRUCTIONS)

  const dynamicTokens = envInfoTokens + gitContextTokens
    + countTokens(mergedInstructions)
    + memoryTokens + taskContextTokens

  const systemPrompt = (activeWorkspace?.systemPrompt || config.systemPrompt) + SYSTEM_PROMPT_CACHE_BOUNDARY + dynamicParts.join('\n\n')

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
  activeWorkspace?: Workspace | null,
  planModeActive?: boolean
): Promise<string> {
  const breakdown = await buildSystemPromptBreakdown(config, activeWorkspace, planModeActive)
  return breakdown.systemPrompt
}

function buildWorkspaceContext(workspace: Workspace): string {
  const lines: string[] = ['# Active Workspace']
  lines.push(`**${workspace.title}**`)
  if (workspace.description) lines.push(workspace.description)
  if (workspace.projects.length > 0) {
    lines.push('')
    lines.push('## Mounted Projects')
    for (const p of workspace.projects) {
      lines.push(`- ${p.name}: \`${p.path}\``)
    }
  }
  return lines.join('\n')
}
