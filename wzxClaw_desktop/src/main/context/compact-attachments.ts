// ============================================================
// Compact Attachments — Post-compact context restoration
// Migrated from Claude Code compact.ts post-compact attachment logic
//
// Restores after compaction:
//   1. Todo list (unfinished tasks)
//   2. Recently referenced files (delegated to compact-file-restore.ts)
//   3. Custom instructions (from .wzxclaw/instructions.md etc)
//   4. Plan file (if exists)
//   5. Active sub-agent status
// ============================================================

import type { Message } from '../../shared/types'
import type { RestoredFile } from './compact-file-restore'

export interface CompactAttachmentContext {
  /** Current todo list */
  todos: Array<{ content: string; status: string }>
  /** Restored file list */
  restoredFiles: RestoredFile[]
  /** Working directory */
  workingDirectory?: string
  /** Custom instructions (from .wzxclaw/instructions.md etc) */
  customInstructions?: string
  /** Plan file content, if any */
  planContent?: string
  /** Plan file path */
  planPath?: string
  /** Active sub-agents / async tasks */
  activeTasks?: Array<{ id: string; description: string; status: string }>
}

/**
 * Build post-compact attachment messages.
 * These are injected after the summary to preserve critical context.
 * Merged into a single user message to avoid consecutive-user rejection.
 */
export function buildPostCompactAttachments(ctx: CompactAttachmentContext): string[] {
  const parts: string[] = []

  // 1. Todo list
  const unfinished = ctx.todos.filter(t => t.status !== 'completed')
  if (unfinished.length > 0) {
    const todoLines = ctx.todos.map(t => {
      const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⏳'
      return icon + ' [' + t.status + '] ' + t.content
    })
    parts.push(
      'Task list at time of context compaction:\n' +
        todoLines.join('\n') +
        '\n\nThere are ' +
        unfinished.length +
        ' unfinished task(s). Resume from where work stopped — do NOT ask the user to repeat the requirements.',
    )
  }

  // 2. Custom instructions
  if (ctx.customInstructions && ctx.customInstructions.trim()) {
    parts.push('User instructions (persist across compaction):\n' + ctx.customInstructions)
  }

  // 3. Plan file
  if (ctx.planContent && ctx.planPath) {
    parts.push(
      'Plan file (' +
        ctx.planPath +
        '):\n' +
        ctx.planContent.slice(0, 5000) +
        (ctx.planContent.length > 5000 ? '\n[... plan truncated ...]' : ''),
    )
  }

  // 4. Active sub-agents
  if (ctx.activeTasks && ctx.activeTasks.length > 0) {
    const taskLines = ctx.activeTasks.map(
      t => '- [' + t.status + '] ' + t.description + ' (id: ' + t.id + ')',
    )
    parts.push('Active background tasks:\n' + taskLines.join('\n'))
  }

  return parts
}

/**
 * Format all post-compact parts into a single system-reminder message.
 */
export function formatPostCompactMessage(ctx: CompactAttachmentContext): Message | null {
  const parts = buildPostCompactAttachments(ctx)

  if (parts.length === 0) return null

  return {
    role: 'user',
    content:
      '<system-reminder>\n' +
      parts.join('\n\n---\n\n') +
      '\n</system-reminder>',
    timestamp: Date.now(),
  }
}
