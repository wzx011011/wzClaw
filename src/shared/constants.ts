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
  { id: 'deepseek-chat', name: 'DeepSeek-V3', provider: 'openai', maxTokens: 8192, contextWindowSize: 64000 },
  { id: 'deepseek-reasoner', name: 'DeepSeek-R1', provider: 'openai', maxTokens: 8192, contextWindowSize: 64000 },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', maxTokens: 8192, contextWindowSize: 200000 },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', provider: 'anthropic', maxTokens: 8192, contextWindowSize: 200000 }
]

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_MAX_TOKENS = 16384
export const DEFAULT_SYSTEM_PROMPT = `You are an expert AI coding assistant. Follow these rules:

1. When asked to write code, ALWAYS output the complete code directly in your response using fenced code blocks. Do NOT just describe what you would write — always show the actual code.
2. When modifying existing code, show the complete modified file or function, not just a description of changes.
3. Prefer using tools (FileWrite, FileEdit) to apply code changes to the user's workspace when possible.
4. Be concise. Lead with the code, then briefly explain key decisions if needed.
5. If you are unsure about requirements, ask a clarifying question before writing code.`
export const MAX_DIFF_FILE_LINES = 5000 // files with more lines skip inline diff
export const DIFF_CONTEXT_LINES = 3     // context lines around each hunk
export const MAX_TOOL_RESULT_CHARS = 30000
export const MAX_FILE_READ_LINES = 2000
export const MAX_AGENT_TURNS = 25

// ============================================================
// Terminal Constants (per TERM-06)
// ============================================================

export const TERMINAL_BUFFER_SIZE = 65536
export const TERMINAL_DEFAULT_COLS = 80
export const TERMINAL_DEFAULT_ROWS = 24

// OpenAI-compatible endpoints
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const GLM_BASE_URL = 'https://open.bigmodel.cn/api/anthropic'
