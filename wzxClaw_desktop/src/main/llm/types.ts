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
  /** API 请求超时（毫秒）。默认 600000 (10min) */
  timeoutMs?: number
  /** If set, tried once after the primary model exhausts its retries. */
  fallbackModel?: string
  /** Invoked before each retry attempt so callers can emit UI notifications. */
  onRetry?: (info: RetryInfo) => void
  /** Thinking depth for extended reasoning (maps to effort/thinking API params) */
  thinkingDepth?: 'none' | 'low' | 'medium' | 'high'
}

export interface LLMAdapter {
  readonly provider: LLMProvider
  stream(options: StreamOptions): AsyncGenerator<StreamEvent>
}
