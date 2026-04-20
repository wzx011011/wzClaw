// ============================================================
// SystemPromptBuilder — 构建系统提示（静态 + 动态分离）
// 从 AgentLoop.run() 中提取，独立测试和复用
// ============================================================

import type { LLMProvider, Task } from '../../shared/types'
import type { AgentConfig } from './types'
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from '../../shared/constants'
import { getGitContext } from '../git/git-context'
import { loadInstructions } from '../context/instruction-loader'
import { buildEnvInfo } from '../context/env-info'
import { MemoryManager } from '../memory/memory-manager'

export interface SystemPromptResult {
  /** 完整系统提示（含缓存边界） */
  systemPrompt: string
  /** 工具定义（从 ToolRegistry 获取，不在 prompt 文本中） */
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
  config: Pick<AgentConfig, 'systemPrompt' | 'workingDirectory' | 'model' | 'provider'>,
  activeTask?: Task | null
): Promise<string> {
  // 并行加载所有动态上下文段
  const [gitContext, instructionSection, memorySection] = await Promise.all([
    getGitContext(config.workingDirectory).catch(() => ''),
    loadInstructions(config.workingDirectory).catch(() => ''),
    new MemoryManager(config.workingDirectory)
      .buildSystemPromptSection()
      .catch(() => ''),
  ])

  // 构建环境信息
  const envInfo = buildEnvInfo({
    model: config.model,
    provider: config.provider,
    workingDirectory: config.workingDirectory,
  })

  // 组装动态部分
  const dynamicParts: string[] = [envInfo]
  if (gitContext) dynamicParts.push(gitContext)
  if (instructionSection) dynamicParts.push(instructionSection)
  if (memorySection) dynamicParts.push(memorySection)
  if (activeTask) dynamicParts.push(buildTaskContext(activeTask))

  // 拼接：静态 + 缓存边界 + 动态
  return config.systemPrompt + SYSTEM_PROMPT_CACHE_BOUNDARY + dynamicParts.join('\n\n')
}

function buildTaskContext(task: Task): string {
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
