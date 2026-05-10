// ============================================================
// Compact Warning State — 压缩警告抑制状态
// 迁移自 Claude Code compactWarningState.ts
//
// 压缩成功后立即抑制警告，因为此时 token 计数不准确，
// 直到下一次 API 响应才会更新。
// ============================================================

let suppressed = false

/** Suppress the compact warning. Call after successful compaction. */
export function suppressCompactWarning(): void {
  suppressed = true
}

/** Clear the compact warning suppression. Called at start of new compact attempt. */
export function clearCompactWarningSuppression(): void {
  suppressed = false
}

/** Check if compact warning is currently suppressed */
export function isCompactWarningSuppressed(): boolean {
  return suppressed
}
