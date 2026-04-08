import type { StreamEvent, LLMProvider } from '../../shared/types'
import type { LLMAdapter, ProviderConfig, StreamOptions } from './types'
import { OpenAIAdapter } from './openai-adapter'
import { AnthropicAdapter } from './anthropic-adapter'

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
    const provider = this.detectProvider(options.model)
    const adapter = this.adapters.get(provider)
    if (!adapter) {
      yield { type: 'error', error: `No adapter configured for provider: ${provider}` }
      return
    }
    yield* adapter.stream(options)
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
