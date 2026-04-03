// ============================================================
// LoopDetector (per D-37)
// ============================================================

/**
 * Detects when the agent loop is stuck making the same tool call
 * repeatedly. After 3+ consecutive identical (name + input) calls,
 * isLooping() returns true.
 */
export class LoopDetector {
  private history: Array<{ name: string; inputKey: string }> = []

  /**
   * Record a tool call for loop detection.
   * Input is serialized with JSON.stringify for comparison.
   */
  record(name: string, input: Record<string, unknown>): void {
    const inputKey = JSON.stringify(input)
    this.history.push({ name, inputKey })
  }

  /**
   * Check if the last 3 tool calls are identical (same name AND input).
   * Returns true if 3+ consecutive identical calls detected.
   */
  isLooping(): boolean {
    if (this.history.length < 3) return false

    const len = this.history.length
    const a = this.history[len - 3]
    const b = this.history[len - 2]
    const c = this.history[len - 1]

    return a.name === b.name && b.name === c.name &&
      a.inputKey === b.inputKey && b.inputKey === c.inputKey
  }

  /**
   * Clear all recorded history.
   */
  reset(): void {
    this.history = []
  }

  /**
   * Get the most recent recorded call, if any.
   */
  getLastCall(): { name: string; inputKey: string } | undefined {
    return this.history[this.history.length - 1]
  }
}
