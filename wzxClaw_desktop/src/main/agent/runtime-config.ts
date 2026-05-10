// ============================================================
// AgentRuntimeConfig — centralized configuration parameters
// Eliminates magic numbers scattered across the codebase
// ============================================================

/**
 * Agent runtime configuration.
 * All thresholds, limits, and strategy parameters live here.
 */
export interface AgentRuntimeConfig {
  // ---- Context management ----
  /** Compact trigger threshold (fraction of context window). 0 = auto formula. Default 0 */
  compactThreshold: number
  /** Auto-compact safety buffer (tokens). threshold = contextWindow - maxOutputTokens - safetyBuffer. Default 13000 */
  compactSafetyBuffer: number
  /** Stop retrying after this many consecutive compact failures. Default 3 */
  maxConsecutiveCompactFailures: number
  /** Target ratio of recent messages to keep (fraction of context window). Default 0.25 */
  compactKeepRatio: number
  /** Max recent messages to keep during compaction. Default 10 */
  compactKeepMax: number
  /** Min recent messages to keep during compaction. Default 2 */
  compactKeepMin: number
  /** DEPRECATED — kept for backward compat. No longer used by context-manager.ts */
  compactSummaryMaxChars: number
  /** Max reactive compactions per run. Default 2 */
  maxReactiveCompacts: number
  /** Number of recent messages to keep during reactive compact. Default 2 */
  reactiveCompactKeepCount: number
  /** Max output tokens for the compact summary itself. Default 20000 */
  compactMaxOutputTokens: number
  /** Token-pressure microcompact threshold (fraction of context window). Default 0.80 */
  microcompactTokenPressureThreshold: number
  /** Pre-compact 触发阈值（上下文窗口比例）。超过此比例时执行提前微压缩。设为 0 禁用。Default 0.60 */
  preCompactThreshold: number

  // ---- Tool result budget ----
  /** Max chars per tool result. Default 30000 */
  maxToolResultChars: number
  /** Max total chars across all tool results. Default 200000 */
  maxTotalToolResultChars: number
  /** Persist tool results to disk above this size. Default 50000 */
  toolResultPersistThresholdChars: number

  // ---- Loop detection ----
  /** Loop detection window. Default 3 */
  loopDetectionWindow: number

  // ---- Agent loop ----
  /** Max turns per run. Default 25 */
  maxAgentTurns: number
  /** Max sub-agent nesting depth. Default 2 */
  maxSubAgentDepth: number
  /** Max input tokens per run (0 = unlimited). Default 0 */
  maxBudgetTokens: number

  // ---- Message management ----
  /** Max chars per message. Default 100000 */
  maxMessageChars: number

  // ---- Microcompact ----
  /** Minutes since last assistant message to trigger microcompact. Default 60 */
  microcompactGapMinutes: number
  /** Keep the N most recent compactable tool results. Default 5 */
  microcompactKeepRecent: number
}

export const DEFAULT_RUNTIME_CONFIG: AgentRuntimeConfig = {
  compactThreshold: 0,
  compactSafetyBuffer: 13_000,
  maxConsecutiveCompactFailures: 3,
  compactKeepRatio: 0.25,
  compactKeepMax: 10,
  compactKeepMin: 2,
  compactSummaryMaxChars: 0, // Deprecated — no longer truncating messages
  maxReactiveCompacts: 2,
  reactiveCompactKeepCount: 2,
  compactMaxOutputTokens: 20_000,
  microcompactTokenPressureThreshold: 0.80,
  preCompactThreshold: 0.60,

  maxToolResultChars: 30_000,
  maxTotalToolResultChars: 200_000,
  toolResultPersistThresholdChars: 50_000,

  loopDetectionWindow: 3,

  maxAgentTurns: 25,
  maxSubAgentDepth: 2,
  maxBudgetTokens: 0,

  maxMessageChars: 100_000,

  microcompactGapMinutes: 60,
  microcompactKeepRecent: 5,
}

export function createRuntimeConfig(
  overrides?: Partial<AgentRuntimeConfig>,
): AgentRuntimeConfig {
  return { ...DEFAULT_RUNTIME_CONFIG, ...overrides }
}
