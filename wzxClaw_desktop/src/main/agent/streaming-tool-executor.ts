// ============================================================
// StreamingToolExecutor (Phase 3.2)
//
// Starts executing each tool as soon as its full JSON input arrives
// (i.e., on tool_use_end / content_block_stop) rather than waiting
// for ALL tool blocks to finish streaming before executing any.
//
// Concurrency model:
//   - Read-only tools: executed immediately in parallel as they arrive
//   - Write tools: chained sequentially via a promise chain so they
//     always execute one at a time in the order the LLM emitted them
//
// After the stream ends, waitAll() resolves all promises in original
// insertion order so the caller can process results deterministically.
// ============================================================

export interface ToolExecResult {
  toolCallId: string
  toolName: string
  /** Original untruncated output — used for agent:tool_result event (UI display) */
  output: string
  /** Truncated output stored in this.messages (fed back to LLM) */
  truncatedOutput: string
  isError: boolean
  loopDetected: boolean
}

type ExecuteFn = () => Promise<ToolExecResult>

export class StreamingToolExecutor {
  /** Ordered list of (id, name, promise) pairs — insertion order = LLM emission order */
  private pending: Array<{ id: string; name: string; promise: Promise<ToolExecResult> }> = []

  /** Sequential chain for write tools — each write tool waits for the previous one */
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(private isReadOnly: (toolName: string) => boolean) {}

  /**
   * Called when a tool_use_end event fires during LLM streaming.
   * Immediately schedules execution of the tool: read-only tools
   * run in parallel, write tools are chained sequentially.
   *
   * @param id - tool call ID from the LLM stream
   * @param name - resolved tool name (from the preceding tool_use_start)
   * @param execute - async function that performs the full tool lifecycle
   *                  (permission check → tool.execute → error handling)
   *                  Must NOT modify this.messages; caller does that after waitAll().
   */
  onToolUseEnd(id: string, name: string, execute: ExecuteFn): void {
    if (this.isReadOnly(name)) {
      // Fire immediately — overlaps with remaining LLM streaming
      const promise = execute()
      this.pending.push({ id, name, promise })
    } else {
      // Chain onto sequential write chain
      // Use .then() with a second arg so a failed prior write doesn't skip this one
      const promise = this.writeChain.then(
        () => execute(),
        () => execute()
      )
      // Absorb errors on the chain itself (result is captured in the promise above)
      this.writeChain = promise.then(
        () => {},
        () => {}
      )
      this.pending.push({ id, name, promise })
    }
  }

  /**
   * Wait for every scheduled tool execution to finish and return
   * results in their original LLM-emission order.
   */
  async waitAll(): Promise<ToolExecResult[]> {
    const results: ToolExecResult[] = []
    for (const { id, name, promise } of this.pending) {
      try {
        // Await each in order — read-only ones are likely already resolved
        results.push(await promise)
      } catch (err) {
        // If a tool promise rejects unexpectedly, wrap it as an error result
        // so remaining tools are not lost
        results.push({
          toolCallId: id,
          toolName: name,
          output: err instanceof Error ? err.message : String(err),
          truncatedOutput: err instanceof Error ? err.message : String(err),
          isError: true,
          loopDetected: false
        })
      }
    }
    return results
  }

  /** Number of tools currently tracked */
  get size(): number {
    return this.pending.length
  }

  /**
   * Get a snapshot of pending tool executions for incremental iteration.
   * Used by stream-phase when yielding tool results as they complete,
   * instead of batching everything via waitAll().
   */
  getPending(): ReadonlyArray<{ id: string; name: string; promise: Promise<ToolExecResult> }> {
    return [...this.pending]
  }
}
