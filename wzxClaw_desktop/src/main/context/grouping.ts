// ============================================================
// Message Grouping — group messages by API round or human turn
// Migrated from Claude Code src/services/compact/grouping.ts
// ============================================================
import type { Message, AssistantMessage } from '../../shared/types'

/**
 * Groups messages at API-round boundaries: one group per API round-trip.
 *
 * A boundary fires when a NEW assistant response begins (different
 * message.id from the prior assistant). For well-formed conversations
 * this is an API-safe split point.
 *
 * When message IDs are absent (legacy messages), falls back to
 * user-prompt grouping (every new user message after an assistant starts a group).
 */
export function groupMessagesByApiRound(messages: Message[]): Message[][] {
  // Check if any assistant has an ID
  let hasAnyId = false
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const asst = msg as AssistantMessage
      if (asst.id !== undefined) {
        hasAnyId = true
        break
      }
    }
  }

  if (!hasAnyId) {
    // Fallback: group by user-prompt boundaries (same as groupMessagesByHumanTurn)
    return groupMessagesByHumanTurn(messages)
  }

  // ID-based grouping
  const groups: Message[][] = []
  let current: Message[] = []
  let lastAssistantId: string | undefined

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const asst = msg as AssistantMessage
      const msgId = asst.id
      const isNewAssistantTurn =
        current.length > 0 &&
        msgId !== undefined &&
        msgId !== lastAssistantId

      if (isNewAssistantTurn) {
        groups.push(current)
        current = [msg]
      } else {
        current.push(msg)
      }
      if (msgId !== undefined) {
        lastAssistantId = msgId
      }
    } else {
      current.push(msg)
    }
  }

  if (current.length > 0) {
    groups.push(current)
  }
  return groups
}

/**
 * Legacy human-turn grouping: boundaries at real user prompts.
 * System-reminder user messages merge into the current turn.
 */
export function groupMessagesByHumanTurn(messages: Message[]): Message[][] {
  const turns: Message[][] = []
  let currentTurn: Message[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (isSystemReminder(msg) && currentTurn.length > 0) {
        currentTurn.push(msg)
        continue
      }
      if (currentTurn.length > 0) {
        turns.push(currentTurn)
      }
      currentTurn = [msg]
    } else {
      currentTurn.push(msg)
    }
  }

  if (currentTurn.length > 0) {
    turns.push(currentTurn)
  }

  return turns
}

function isSystemReminder(msg: Message): boolean {
  return typeof msg.content === 'string' &&
    msg.content.startsWith('<system-reminder>')
}
