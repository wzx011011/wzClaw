import type { StreamEvent, LLMProvider } from '../../shared/types'
import type { RetryInfo } from './retry'

export type { RetryInfo }

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
  /** If set, tried once after the primary model exhausts its retries. */
  fallbackModel?: string
  /** Invoked before each retry attempt so callers can emit UI notifications. */
  onRetry?: (info: RetryInfo) => void
}

export interface LLMAdapter {
  readonly provider: LLMProvider
  stream(options: StreamOptions): AsyncGenerator<StreamEvent>
}
