// ============================================================
// Brain 包需要的常量定义
// 从 wzxClaw_desktop/src/shared/constants.ts 提取
// 无 Electron 依赖
// ============================================================

// ============================================================
// Default Model List (per D-15)
// ============================================================

export interface ModelPreset {
  id: string
  name: string
  provider: 'openai' | 'anthropic'
  maxTokens: number
  contextWindowSize: number
}

export const DEFAULT_MODELS: ModelPreset[] = [
  { id: 'glm-5.1', name: 'GLM-5.1', provider: 'anthropic', maxTokens: 16384, contextWindowSize: 128000 },
  { id: 'glm-5-turbo', name: 'GLM-5 Turbo', provider: 'anthropic', maxTokens: 16384, contextWindowSize: 128000 },
  { id: 'glm-5', name: 'GLM-5', provider: 'anthropic', maxTokens: 16384, contextWindowSize: 128000 },
  { id: 'glm-4-plus', name: 'GLM-4 Plus', provider: 'openai', maxTokens: 8192, contextWindowSize: 128000 },
  { id: 'glm-4-flash', name: 'GLM-4 Flash', provider: 'openai', maxTokens: 8192, contextWindowSize: 128000 },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', maxTokens: 16384, contextWindowSize: 128000 },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', maxTokens: 16384, contextWindowSize: 128000 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4 Pro', provider: 'openai', maxTokens: 8192, contextWindowSize: 64000 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4 Flash', provider: 'openai', maxTokens: 8192, contextWindowSize: 64000 },
  { id: 'deepseek-chat', name: 'DeepSeek-V3', provider: 'openai', maxTokens: 8192, contextWindowSize: 64000 },
  { id: 'deepseek-reasoner', name: 'DeepSeek-R1', provider: 'openai', maxTokens: 8192, contextWindowSize: 64000 },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', maxTokens: 8192, contextWindowSize: 200000 },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', provider: 'anthropic', maxTokens: 8192, contextWindowSize: 200000 }
]

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_MAX_TOKENS = 16384

// 主对话安全天花板：正常对话靠 compaction + shouldStop 自然终止，
// 不会达到此限制。仅作为意外死循环的最后防线。
export const MAX_AGENT_TURNS = 200

// Boundary marker for system prompt cache layering.
// Content before this marker is static (cacheable across turns).
// Content after is dynamic (changes per session/turn).
export const SYSTEM_PROMPT_CACHE_BOUNDARY = '\n<!-- CACHE_BOUNDARY -->\n'

// Second boundary: separates tool definitions from dynamic context.
// Allows caching tool defs independently (they change only when tools are added/removed).
export const TOOL_DEFS_CACHE_BOUNDARY = '\n<!-- TOOL_DEFS_BOUNDARY -->\n'
