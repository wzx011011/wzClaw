// ============================================================
// SystemPromptBuilder — 注入指令到 system prompt
// 在基础 system prompt 后追加 skills/commands/memory
// ============================================================

import { loadInstructions, type InstructionSections, getConfigDir } from './instruction-loader.js'

/** Cache boundary 标记（与桌面端一致） */
export const SYSTEM_PROMPT_CACHE_BOUNDARY = '<!-- SYSTEM_PROMPT_CACHE_BOUNDARY -->'

/** 构建 system prompt 的配置 */
export interface SystemPromptConfig {
  /** 基础 system prompt */
  basePrompt: string
  /** 配置目录路径（可选，默认 getConfigDir()） */
  configDir?: string
}

/**
 * 构建完整的 system prompt
 *
 * 结构:
 * [base prompt]
 * <!-- SYSTEM_PROMPT_CACHE_BOUNDARY -->
 * [merged instructions: memory + commands + skills]
 */
export function buildSystemPrompt(config: SystemPromptConfig): string {
  const configDir = config.configDir || getConfigDir()
  const sections = loadInstructions(configDir)

  if (!sections.merged) {
    return config.basePrompt
  }

  return `${config.basePrompt}\n\n${SYSTEM_PROMPT_CACHE_BOUNDARY}\n\n${sections.merged}`
}

/**
 * 重新加载指令并返回新的 sections（不改变 base prompt）
 */
export function reloadInstructions(configDir?: string): InstructionSections {
  return loadInstructions(configDir || getConfigDir())
}
