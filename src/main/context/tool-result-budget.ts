// ============================================================
// Tool Result Budget — Per-tool truncation with smart strategies
// ============================================================

const MAX_CHARS_PER_RESULT = 30_000
const MAX_TOTAL_CHARS = 200_000

type TruncationStrategy = 'head' | 'tail' | 'middle'

/**
 * Per-tool truncation strategies:
 *
 *  FileRead  → 'middle': keep file head + tail, cut the middle.
 *               This preserves imports/declarations (head) and the end of
 *               the file (tail) — the most useful parts when exploring code.
 *
 *  Bash      → 'tail': keep the last N chars.
 *               Terminal output is most useful at the end (final result,
 *               error messages, prompt) so we drop old scroll-back.
 *
 *  Grep/Glob → 'head': keep the first N matches.
 *               Match lists are most useful at the top; excess matches are
 *               less relevant and can be re-queried with more specific params.
 *
 *  default   → 'tail': conservative fallback — recent output is most useful.
 */
function strategyForTool(toolName: string): TruncationStrategy {
  switch (toolName) {
    case 'FileRead':
      return 'middle'
    case 'Bash':
      return 'tail'
    case 'Grep':
    case 'Glob':
      return 'head'
    default:
      return 'tail'
  }
}

/**
 * Truncate a single tool result string using the tool-specific strategy.
 *
 * If the result fits within `maxChars` (default: MAX_CHARS_PER_RESULT),
 * it is returned unchanged. Otherwise:
 *
 *  'head'   — keeps the first maxChars characters
 *  'tail'   — keeps the last maxChars characters
 *  'middle' — keeps the first half + last half (equal split), skipping
 *             the middle section of the result
 *
 * A truncation notice is always appended so the LLM knows data was cut.
 */
export function truncateToolResult(
  toolName: string,
  result: string,
  maxChars: number = MAX_CHARS_PER_RESULT
): string {
  if (result.length <= maxChars) return result

  const total = result.length
  const strategy = strategyForTool(toolName)
  let truncated: string

  switch (strategy) {
    case 'head': {
      truncated = result.slice(0, maxChars)
      break
    }
    case 'tail': {
      truncated = result.slice(total - maxChars)
      break
    }
    case 'middle': {
      // Keep equal halves from head and tail
      const half = Math.floor(maxChars / 2)
      const head = result.slice(0, half)
      const tail = result.slice(total - half)
      truncated = `${head}\n...[middle truncated]...\n${tail}`
      break
    }
  }

  const shown = truncated.replace(/\n\.\.\.\[middle truncated\]\.\.\.\n/, '').length
  return `${truncated}\n[Truncated: showing ${shown}/${total} chars. Use offset/limit params to see more.]`
}

// ============================================================
// Context budget enforcement across multiple tool results
// ============================================================

export interface ToolResultEntry {
  toolName: string
  result: string
  turnIndex: number
}

/**
 * Enforce a total character budget across all accumulated tool results.
 *
 * If the combined size exceeds MAX_TOTAL_CHARS, oldest results (lowest
 * turnIndex) are compacted first. Compacted results are replaced with a
 * placeholder that notes how many characters were removed, preserving
 * the structural shape of the message history.
 *
 * Returns a new array (does not mutate input).
 */
export function enforceContextBudget(
  toolResults: ToolResultEntry[]
): ToolResultEntry[] {
  const total = toolResults.reduce((sum, r) => sum + r.result.length, 0)
  if (total <= MAX_TOTAL_CHARS) return toolResults

  // Work on a shallow copy sorted oldest-first for compaction priority
  const sorted = [...toolResults].sort((a, b) => a.turnIndex - b.turnIndex)
  let excess = total - MAX_TOTAL_CHARS

  const compacted = sorted.map((entry) => {
    if (excess <= 0) return entry
    if (entry.result.startsWith('[Result compacted')) return entry

    const chars = entry.result.length
    if (chars > MAX_CHARS_PER_RESULT / 2) {
      // Compact this entry
      excess -= chars
      return {
        ...entry,
        result: `[Result compacted — ${chars} chars removed to fit context budget]`
      }
    }
    return entry
  })

  // Restore original order (by turnIndex)
  return compacted.sort((a, b) => a.turnIndex - b.turnIndex)
}
