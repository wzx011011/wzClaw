import type { StreamEvent, LLMProvider } from '../../shared/types'

export interface ProviderConfig {
  provider: LLMProvider
  apiKey: string
  baseURL?: string
  defaultModel?: string
}

export interface StreamOptions {
  model: string
  messages: Array<{ role: string; content: unknown }>
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  tools?: Array<{
    name: string
    description: string
    input_schema: Record<string, unknown>
  }>
  abortSignal?: AbortSignal
}

export interface LLMAdapter {
  readonly provider: LLMProvider
  stream(options: StreamOptions): AsyncGenerator<StreamEvent>
}
