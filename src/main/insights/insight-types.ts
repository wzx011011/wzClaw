// ============================================================
// insight-types.ts — /insights 管线共享类型
// 对齐 Claude Code /insights 的完整数据模型
// ============================================================

/** Per-session metadata extracted from JSONL (no LLM cost) */
export interface SessionInsightMeta {
  sessionId: string
  projectHash: string
  title: string
  createdAt: number
  updatedAt: number
  userMessageCount: number
  assistantMessageCount: number
  toolCallCount: number
  toolCounts: Record<string, number>
  toolErrorCount: number
  toolErrorCategories: Record<string, number>
  totalInputTokens: number
  totalOutputTokens: number
  estimatedCostUSD: number
  model: string
  durationMs: number
  languages: string[]
  filesModified: number
  linesAdded: number
  linesRemoved: number
  gitCommits: number
  gitPushes: number
  userInterruptions: number
  userResponseTimes: number[]        // seconds between assistant msg and next user msg
  usesTaskAgent: boolean
  usesMcp: boolean
  usesWebSearch: boolean
  usesWebFetch: boolean
  firstPrompt: string                 // first user message text
  messageHours: number[]              // hour-of-day (0-23) for each user message
  userMessageTimestamps: string[]     // ISO timestamps for multi-clauding detection
}

/** Per-session facets extracted by LLM (cached) */
export interface SessionFacets {
  sessionId: string
  extractedAt: number
  underlyingGoal: string
  goalCategories: Record<string, number>  // { debug: 2, feature: 1 }
  outcome: 'fully_achieved' | 'mostly_achieved' | 'partially_achieved' | 'not_achieved' | 'unclear'
  userSatisfaction: Record<string, number>  // { happy: 1, satisfied: 3, likely_satisfied: 2 }
  claudeHelpfulness: 'unhelpful' | 'slightly_helpful' | 'moderately_helpful' | 'very_helpful' | 'essential'
  sessionType: 'single_task' | 'multi_task' | 'iterative_refinement' | 'exploration' | 'quick_question'
  frictionCounts: Record<string, number>  // { misunderstood_request: 1, buggy_code: 2 }
  frictionDetail: string
  primarySuccess: string   // none | fast_accurate_search | correct_code_edits | ...
  briefSummary: string
  userInstructionsToClaude?: string[]  // repeated instructions the user gave
}

/** Cross-session aggregation */
export interface AggregatedInsightData {
  totalSessions: number
  totalSessionsScanned?: number
  sessionsWithFacets: number
  dateRange: { earliest: number; latest: number }
  totalTokens: { input: number; output: number }
  totalCostUSD: number
  totalDurationHours: number
  totalMessages: number
  totalGitCommits: number
  totalGitPushes: number
  totalInterruptions: number
  totalToolErrors: number
  toolErrorCategories: Record<string, number>
  medianResponseTime: number
  avgResponseTime: number
  sessionsByOutcome: Record<string, number>
  sessionsByType: Record<string, number>
  sessionsByHelpfulness: Record<string, number>
  sessionsBySatisfaction: Record<string, number>
  goalCategories: Record<string, number>
  friction: Record<string, number>
  success: Record<string, number>
  topTools: Array<{ name: string; count: number }>
  topModels: Array<{ model: string; sessions: number; inputTokens: number; outputTokens: number }>
  topLanguages: Array<{ lang: string; count: number }>
  topProjects: Record<string, number>
  avgTokensPerSession: number
  avgCostPerSession: number
  avgDurationMinutes: number
  avgToolSuccessRate: number
  totalLinesAdded: number
  totalLinesRemoved: number
  totalFilesModified: number
  daysActive: number
  messagesPerDay: number
  messageHours: number[]
  sessionsUsingTaskAgent: number
  sessionsUsingMcp: number
  sessionsUsingWebSearch: number
  sessionsUsingWebFetch: number
  sessionSummaries: Array<{ id: string; date: string; summary: string; goal?: string }>
  multiClauding: {
    overlapEvents: number
    sessionsInvolved: number
    userMessagesDuring: number
  }
}

/** One LLM-generated insight section */
export interface InsightSection {
  id: string
  title: string
  content: string // markdown
}

/** Progress event pushed to renderer during pipeline */
export interface InsightProgress {
  stage: 'scanning' | 'extracting_facets' | 'aggregating' | 'generating_insights' | 'rendering' | 'done'
  current: number
  total: number
  message: string
}

/** IPC response from insights:generate */
export interface InsightResult {
  summary: string
  htmlPath: string
  totalSessions: number
  totalCostUSD: number
}
