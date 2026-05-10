// ============================================================
// Session Memory Compact — API-round-based pruning (no API call)
// Migrated from Claude Code sessionMemoryCompact.ts
//
// Core idea: before triggering LLM summarization, try simply
// dropping the oldest API rounds. Zero-cost compression.
// ============================================================

import type { Message } from '../../shared/types'
import { countMessagesTokens } from './token-counter'
import { groupMessagesByApiRound } from './grouping'

export interface SessionMemoryCompactResult {
  /** Pruned messages */
  messages: Message[]
  /** How many messages were pruned */
  messagesPruned: number
  /** Token count before pruning */
  beforeTokens: number
  /** Token count after pruning */
  afterTokens: number
}

/**
 * Try session memory compaction:
 * Group by API round, drop oldest until under threshold.
 * Always keep at least 1 round (the most recent).
 *
 * Returns null if pruning does not help enough (caller should fall back to LLM summary).
 */
export function trySessionMemoryCompact(
  messages: Message[],
  contextWindowTokens: number,
  compactThreshold: number,
  modelId?: string,
): SessionMemoryCompactResult | null {
  if (messages.length === 0) return null

  const beforeTokens = countMessagesTokens(messages, modelId)
  if (beforeTokens <= compactThreshold) return null

  const groups = groupMessagesByApiRound(messages)
  if (groups.length < 2) return null

  // Keep dropping oldest groups until under threshold
  let prunedGroupCount = 0
  let keptGroups = groups

  for (let dropCount = 1; dropCount < groups.length; dropCount++) {
    const candidate = groups.slice(dropCount)
    const candidateTokens = countMessagesTokens(candidate.flat(), modelId)

    if (candidateTokens <= compactThreshold) {
      prunedGroupCount = dropCount
      keptGroups = candidate
      break
    }

    // Last iteration: keep only the most recent group
    if (dropCount === groups.length - 1) {
      prunedGroupCount = dropCount
      keptGroups = [groups[groups.length - 1]]
    }
  }

  if (prunedGroupCount === 0) return null

  const resultMessages = keptGroups.flat()
  const afterTokens = countMessagesTokens(resultMessages, modelId)
  const messagesPruned = messages.length - resultMessages.length

  return {
    messages: resultMessages,
    messagesPruned,
    beforeTokens,
    afterTokens,
  }
}
