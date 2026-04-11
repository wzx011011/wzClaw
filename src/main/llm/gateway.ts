import type { StreamEvent, LLMProvider } from '../../shared/types'
import type { LLMAdapter, ProviderConfig, StreamOptions } from './types'
import { OpenAIAdapter } from './openai-adapter'
import { AnthropicAdapter } from './anthropic-adapter'
import { withRetry } from './retry'

export class LLMGateway {
  private adapters: Map<LLMProvider, LLMAdapter> = new Map()

  addProvider(config: ProviderConfig): void {
    switch (config.provider) {
      case 'openai':
        this.adapters.set('openai', new OpenAIAdapter(config))
        break
      case 'anthropic':
        this.adapters.set('anthropic', new AnthropicAdapter(config))
        break
      default:
        throw new Error(`Unknown provider: ${config.provider}`)
    }
  }

  async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
    const primaryProvider = this.detectProvider(options.model)
    if (!this.adapters.has(primaryProvider)) {
      yield { type: 'error', error: `No adapter configured for provider: ${primaryProvider}` }
      return
    }

    // Factory thunk: given a model name, returns a fresh stream generator.
    // Supports transparent model switching for fallback retries.
    const thunk = (model: string): AsyncGenerator<StreamEvent> => {
      const provider = this.detectProvider(model)
      const adapter = this.adapters.get(provider)
      if (!adapter) {
        return (async function* () {
          yield { type: 'error' as const, error: `No adapter configured for provider: ${provider}` }
        })()
      }
      return adapter.stream({ ...options, model })
    }

    yield* withRetry(thunk, options.model, {
      maxRetries: 3,
      fallbackModel: options.fallbackModel,
      onRetry: options.onRetry,
    })
  }

  private detectProvider(model: string): LLMProvider {
    if (model.startsWith('claude')) return 'anthropic'
    if (model.startsWith('glm-5')) return 'anthropic' // GLM-5 series via Anthropic-compatible API
    return 'openai' // OpenAI, DeepSeek, and any OpenAI-compatible endpoint
  }

  getAdapter(provider: LLMProvider): LLMAdapter | undefined {
    return this.adapters.get(provider)
  }

  hasProvider(provider: LLMProvider): boolean {
    return this.adapters.has(provider)
  }
}
