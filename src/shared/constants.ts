// ============================================================
// Default Model List (per D-15)
// ============================================================

export interface ModelPreset {
  id: string
  name: string
  provider: 'openai' | 'anthropic'
  maxTokens: number
}

export const DEFAULT_MODELS: ModelPreset[] = [
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', maxTokens: 16384 },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', maxTokens: 16384 },
  { id: 'deepseek-chat', name: 'DeepSeek-V3', provider: 'openai', maxTokens: 8192 },
  { id: 'deepseek-reasoner', name: 'DeepSeek-R1', provider: 'openai', maxTokens: 8192 },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', maxTokens: 8192 },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', provider: 'anthropic', maxTokens: 8192 }
]

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_MAX_TOKENS = 8192
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI coding assistant.'
export const MAX_TOOL_RESULT_CHARS = 30000
export const MAX_FILE_READ_LINES = 2000
export const MAX_AGENT_TURNS = 25

// OpenAI-compatible endpoints
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
