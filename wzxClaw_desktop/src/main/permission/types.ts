// ============================================================
// Permission Types
// ============================================================

/**
 * Permission modes matching Z Code's 4-mode system:
 * - always-ask: Prompt for every destructive tool (default)
 * - accept-edits: Auto-allow file write/edit, still prompt for Bash
 * - plan: All tools require approval (read-only too)
 * - bypass: Skip all permission checks
 */
export type PermissionMode = 'always-ask' | 'accept-edits' | 'plan' | 'bypass'

export const PERMISSION_MODES: PermissionMode[] = ['always-ask', 'accept-edits', 'plan', 'bypass']

/**
 * A permission rule for glob-based path matching.
 */
export interface PermissionRule {
  pattern: string // glob pattern (e.g., "src/**/*.ts")
  toolName: string // tool name this applies to (or '*' for all)
  action: 'allow' | 'deny'
}

/**
 * Tracks denial counts to prevent infinite denial loops.
 */
export interface DenialRecord {
  consecutive: number
  total: number
}

export const MAX_CONSECUTIVE_DENIALS = 3
export const MAX_TOTAL_DENIALS = 20
