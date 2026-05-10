// ============================================================
// PTL Recovery — Prompt-Too-Long error recovery
// Migrated from Claude Code compact.ts truncateHeadForPTLRetry
//
// When the compact request itself hits prompt-too-long, drops
// the oldest API-round groups and retries up to MAX_PTL_RETRIES.
// This is the last-resort escape hatch — otherwise user is stuck.
// ============================================================

import type { Message } from '../../shared/types'
import { countMessagesTokens } from './token-counter'
import { groupMessagesByApiRound } from './grouping'

export const MAX_PTL_RETRIES = 3
const PTL_RETRY_MARKER = '[earlier conversation truncated for compaction retry]'

/**
 * Drops the oldest API-round groups from messages until token pressure is relieved.
 * Returns null when nothing can be dropped without leaving an empty summarize set.
 */
export function truncateHeadForPTLRetry(
  messages: Message[],
  ptlErrorMessage: string,
): Message[] | null {
  // Strip our own synthetic marker from a previous retry before grouping
  const input =
    messages[0]?.role === 'user' &&
    typeof messages[0].content === 'string' &&
    messages[0].content === PTL_RETRY_MARKER
      ? messages.slice(1)
      : messages

  const groups = groupMessagesByApiRound(input)
  if (groups.length < 2) return null

  // Try to extract token gap from error message
  const tokenGap = extractTokenGap(ptlErrorMessage)
  let dropCount: number

  if (tokenGap !== undefined) {
    // Drop enough groups to cover the gap
    let acc = 0
    dropCount = 0
    for (const g of groups) {
      acc += countMessagesTokens(g)
      dropCount++
      if (acc >= tokenGap) break
    }
  } else {
    // Fallback: drop 20% of groups
    dropCount = Math.max(1, Math.floor(groups.length * 0.2))
  }

  // Keep at least one group so there is something to summarize
  dropCount = Math.min(dropCount, groups.length - 1)
  if (dropCount < 1) return null

  const sliced = groups.slice(dropCount).flat()

  // If the first message after dropping is an assistant message, prepend a
  // synthetic user marker (API requires first message to be role=user)
  if (sliced[0]?.role === 'assistant') {
    return [
      { role: 'user', content: PTL_RETRY_MARKER, timestamp: Date.now() },
      ...sliced,
    ]
  }
  return sliced
}

/**
 * Try to extract the token gap from a prompt-too-long error message.
 * Various providers format this differently.
 */
function extractTokenGap(errorMessage: string): number | undefined {
  // Anthropic: "prompt is too long: X tokens > Y tokens"
  const anthropicMatch = errorMessage.match(/too long:\s*(\d+)\s*tokens?\s*>\s*(\d+)/i)
  if (anthropicMatch) {
    return parseInt(anthropicMatch[1]) - parseInt(anthropicMatch[2])
  }

  // OpenAI: "maximum context length is Y but you requested X"
  const openaiMatch = errorMessage.match(/maximum context length is (\d+).*?requested (\d+)/i)
  if (openaiMatch) {
    return parseInt(openaiMatch[2]) - parseInt(openaiMatch[1])
  }

  return undefined
}

export { PTL_RETRY_MARKER }
