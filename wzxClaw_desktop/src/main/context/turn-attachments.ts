// ============================================================
// Per-Turn Attachments — Context injected between tool-use turns
// ============================================================
//
// Modeled after Claude Code's attachment system. Before each LLM call
// (after the first), we inject brief contextual nudges into the
// conversation so the model stays aware of changed state.

import type { Message } from '../../shared/types'

/**
 * Wrap text in a <system-reminder> tag.
 * The system prompt instructs the LLM to treat these as trusted system context.
 */
export function wrapSystemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`
}

export interface TurnAttachmentContext {
  /** Files that have been read during this session (path → last-read turn) */
  filesRead: Map<string, number>
  /** Files that have been written/edited during this session (path → last-write turn) */
  filesWritten: Map<string, number>
  /** Current turn number */
  currentTurn: number
  /** Active tasks from CreateTask/UpdateTask */
  activeWorkspaces?: Array<{ id: string; subject: string; status: string }>
}

/**
 * Build per-turn attachment text to inject before the next LLM call.
 * Returns empty string if no attachments are needed.
 */
export function buildTurnAttachments(ctx: TurnAttachmentContext): string {
  const parts: string[] = []

  // 1. Changed files reminder — files written since they were last read
  const changedFiles: string[] = []
  for (const [filePath, writeTurn] of ctx.filesWritten) {
    const readTurn = ctx.filesRead.get(filePath)
    if (readTurn !== undefined && writeTurn > readTurn) {
      changedFiles.push(filePath)
    }
  }
  if (changedFiles.length > 0) {
    parts.push(wrapSystemReminder(
      `The following files have been modified since you last read them. Consider re-reading before editing:\n${changedFiles.map(f => `- ${f}`).join('\n')}`
    ))
  }

  // 2. Active tasks reminder (if tasks exist and are in progress)
  if (ctx.activeWorkspaces && ctx.activeWorkspaces.length > 0) {
    const inProgress = ctx.activeWorkspaces.filter(t => t.status === 'in_progress')
    const pending = ctx.activeWorkspaces.filter(t => t.status === 'pending')
    if (inProgress.length > 0 || pending.length > 0) {
      const lines: string[] = ['Active tasks:']
      for (const t of inProgress) {
        lines.push(`- [in_progress] ${t.subject}`)
      }
      for (const t of pending) {
        lines.push(`- [pending] ${t.subject}`)
      }
      parts.push(wrapSystemReminder(lines.join('\n')))
    }
  }

  return parts.join('\n')
}

/**
 * Tracks files that have been read and written across agent loop turns.
 * Used to detect stale reads and generate changed-file reminders.
 */
export class FileChangeTracker {
  private filesRead = new Map<string, number>()
  private filesWritten = new Map<string, number>()
  private currentTurn = 0

  /** Call at the start of each new agent turn */
  advanceTurn(): void {
    this.currentTurn++
  }

  /** Record that a file was read (from FileRead tool result) */
  recordRead(filePath: string): void {
    this.filesRead.set(filePath, this.currentTurn)
  }

  /** Record that a file was written or edited (from FileWrite/FileEdit tool result) */
  recordWrite(filePath: string): void {
    this.filesWritten.set(filePath, this.currentTurn)
  }

  /** Get the current tracking context for building attachments */
  getContext(): Pick<TurnAttachmentContext, 'filesRead' | 'filesWritten' | 'currentTurn'> {
    return {
      filesRead: this.filesRead,
      filesWritten: this.filesWritten,
      currentTurn: this.currentTurn
    }
  }

  /** Reset all tracking state */
  reset(): void {
    this.filesRead.clear()
    this.filesWritten.clear()
    this.currentTurn = 0
  }
}
