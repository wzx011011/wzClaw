// ============================================================
// Model Pricing Table (Phase 4.4)
// ============================================================

export interface ModelPricing {
  inputPerMToken: number    // USD per 1M input tokens
  outputPerMToken: number   // USD per 1M output tokens
  cacheReadPerMToken?: number  // USD per 1M cache-read tokens (Anthropic only)
  cacheWritePerMToken?: number // USD per 1M cache-write tokens (Anthropic only)
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-4':    { inputPerMToken: 15,   outputPerMToken: 75,   cacheReadPerMToken: 1.5,  cacheWritePerMToken: 18.75 },
  'claude-sonnet-4':  { inputPerMToken: 3,    outputPerMToken: 15,   cacheReadPerMToken: 0.3,  cacheWritePerMToken: 3.75  },
  'claude-haiku':     { inputPerMToken: 0.8,  outputPerMToken: 4,    cacheReadPerMToken: 0.08, cacheWritePerMToken: 1.0   },
  'claude-3-5-haiku': { inputPerMToken: 0.8,  outputPerMToken: 4,    cacheReadPerMToken: 0.08, cacheWritePerMToken: 1.0   },

  // OpenAI
  'gpt-4o':      { inputPerMToken: 2.5,  outputPerMToken: 10  },
  'gpt-4o-mini': { inputPerMToken: 0.15, outputPerMToken: 0.6 },
  'o1':          { inputPerMToken: 15,   outputPerMToken: 60  },
  'o1-mini':     { inputPerMToken: 3,    outputPerMToken: 12  },

  // DeepSeek
  'deepseek-chat':     { inputPerMToken: 0.27, outputPerMToken: 1.10 },
  'deepseek-reasoner': { inputPerMToken: 0.55, outputPerMToken: 2.19 },

  // GLM (ZhipuAI) — approximate
  'glm-5':   { inputPerMToken: 0.5, outputPerMToken: 1.5 },
  'glm-4':   { inputPerMToken: 0.1, outputPerMToken: 0.1 },
}

/**
 * Fuzzy match: checks if modelName contains any pricing key as a substring.
 * Returns the pricing for the longest matching key (most specific match first).
 */
export function getPricing(modelName: string): ModelPricing | null {
  const lower = modelName.toLowerCase()
  // Sort keys by length descending so longer (more specific) keys match first
  const sortedKeys = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length)
  for (const key of sortedKeys) {
    if (lower.includes(key.toLowerCase())) {
      return MODEL_PRICING[key]
    }
  }
  return null
}
