// ============================================================
// Tool Result Budget — Per-tool truncation with smart strategies
// 所有阈值从 AgentRuntimeConfig 获取，消除重复定义
// ============================================================

import { DEFAULT_RUNTIME_CONFIG } from '../agent/runtime-config'

type TruncationStrategy = 'head' | 'tail' | 'middle'

/**
 * Per-tool truncation strategies:
 *
 *  FileRead  → 'middle': keep file head + tail, cut the middle.
 *  Bash      → 'tail': keep the last N chars.
 *  Grep/Glob → 'head': keep the first N matches.
 *  default   → 'tail': conservative fallback.
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
 */
export function truncateToolResult(
  toolName: string,
  result: string,
  maxChars: number = DEFAULT_RUNTIME_CONFIG.maxToolResultChars
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
 * Oldest results (lowest turnIndex) are compacted first.
 */
export function enforceContextBudget(
  toolResults: ToolResultEntry[],
  maxTotalChars: number = DEFAULT_RUNTIME_CONFIG.maxTotalToolResultChars,
  maxPerResult: number = DEFAULT_RUNTIME_CONFIG.maxToolResultChars,
): ToolResultEntry[] {
  const total = toolResults.reduce((sum, r) => sum + r.result.length, 0)
  if (total <= maxTotalChars) return toolResults

  const sorted = [...toolResults].sort((a, b) => a.turnIndex - b.turnIndex)
  let excess = total - maxTotalChars

  const compacted = sorted.map((entry) => {
    if (excess <= 0) return entry
    if (entry.result.startsWith('[Result compacted')) return entry

    const chars = entry.result.length
    if (chars > maxPerResult / 2) {
      excess -= chars
      return {
        ...entry,
        result: `[Result compacted — ${chars} chars removed to fit context budget]`
      }
    }
    return entry
  })

  return compacted.sort((a, b) => a.turnIndex - b.turnIndex)
}
