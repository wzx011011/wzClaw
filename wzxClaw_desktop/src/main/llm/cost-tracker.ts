import { getPricing } from './model-cost'

// ============================================================
// CostTracker — accumulates token usage and computes cost
// for the current session (Phase 4.4)
// ============================================================

export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalCostUSD: number
  model: string
}

export class CostTracker {
  private session: SessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCostUSD: 0,
    model: ''
  }

  addUsage(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0
  ): void {
    this.session.model = model
    this.session.inputTokens += inputTokens
    this.session.outputTokens += outputTokens
    this.session.cacheReadTokens += cacheReadTokens
    this.session.cacheWriteTokens += cacheWriteTokens

    const pricing = getPricing(model)
    if (pricing) {
      const inputCost   = (inputTokens   / 1_000_000) * pricing.inputPerMToken
      const outputCost  = (outputTokens  / 1_000_000) * pricing.outputPerMToken
      const cacheRead   = (cacheReadTokens  / 1_000_000) * (pricing.cacheReadPerMToken  ?? 0)
      const cacheWrite  = (cacheWriteTokens / 1_000_000) * (pricing.cacheWritePerMToken ?? 0)
      this.session.totalCostUSD += inputCost + outputCost + cacheRead + cacheWrite
    }
  }

  getSession(): SessionUsage {
    return { ...this.session }
  }

  resetSession(): void {
    this.session = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUSD: 0,
      model: ''
    }
  }

  /**
   * Returns a compact string like "$0.0123 | 45.2K tok"
   * for display in the status bar.
   */
  formatDisplay(): string {
    const cost = this.session.totalCostUSD
    const total = this.session.inputTokens + this.session.outputTokens
    const tokStr = total >= 1000
      ? `${(total / 1000).toFixed(1)}K tok`
      : `${total} tok`
    const costStr = `$${cost.toFixed(4)}`
    return `${costStr} | ${tokStr}`
  }
}
