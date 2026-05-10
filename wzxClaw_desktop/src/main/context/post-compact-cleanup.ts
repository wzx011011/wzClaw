// ============================================================
// Post Compact Cleanup — state cleanup after compaction
// Migrated from Claude Code postCompactCleanup.ts
// ============================================================

import { resetMicrocompactState } from './microcompact'
import { clearCompactWarningSuppression } from './compact-warning-state'

/**
 * Run cleanup of caches and tracking state after compaction.
 * Call this after both auto-compact and manual compact.
 */
export function runPostCompactCleanup(): void {
  resetMicrocompactState()
  clearCompactWarningSuppression()
  // Future: clear other caches as needed (memory files, classifier approvals, etc.)
}
