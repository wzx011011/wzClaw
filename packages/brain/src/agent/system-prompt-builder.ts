// ============================================================
// SystemPromptBuilder — 简化版（Brain 包）
// 只处理 cache boundary 拼接逻辑
// 完整的 env/git/instruction/memory 组装由桌面端/Hands 在调用 Brain 前完成
// ============================================================

import { SYSTEM_PROMPT_CACHE_BOUNDARY } from '../constants.js'

/**
 * 构建 Brain 包的系统提示。
 * 将静态提示和动态部分通过 cache boundary 拼接。
 *
 * 结构：
 *   [staticPrompt]
 *   <!-- CACHE_BOUNDARY -->
 *   [dynamicPart1]
 *
 *   [dynamicPart2]
 *   ...
 *
 * 静态部分跨会话不变，可被 Anthropic prompt caching 缓存。
 * 动态部分每会话可能变化。
 */
export function buildBrainSystemPrompt(
  staticPrompt: string,
  dynamicParts: string[],
): string {
  const dynamicContent = dynamicParts.filter(p => p.length > 0).join('\n\n')
  if (!dynamicContent) return staticPrompt
  return staticPrompt + SYSTEM_PROMPT_CACHE_BOUNDARY + dynamicContent
}
