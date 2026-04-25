// ============================================================
// AgentRuntimeConfig — 集中管理所有可配置参数
// 消除散落在代码中的魔法数字
// ============================================================

/**
 * Agent 运行时配置。
 * 所有阈值、限制、策略参数集中在此，便于调优和测试。
 * 未指定时使用默认值。
 */
export interface AgentRuntimeConfig {
  // ---- 上下文管理 ----
  /** 压缩触发阈值（占上下文窗口的比例）。设为 0 则使用自动公式。默认 0（自动） */
  compactThreshold: number
  /** 自动压缩安全缓冲（tokens）。阈值 = contextWindow - maxOutputTokens - safetyBuffer。默认 13000 */
  compactSafetyBuffer: number
  /** 连续压缩失败后停止重试的次数。默认 3 */
  maxConsecutiveCompactFailures: number
  /** 主动压缩保留近期消息的目标比例（占上下文窗口）。默认 0.25 */
  compactKeepRatio: number
  /** 主动压缩最大保留条数。默认 10 */
  compactKeepMax: number
  /** 主动压缩最小保留条数。默认 2 */
  compactKeepMin: number
  /** 摘要时每条消息截取的最大字符数。默认 500 */
  compactSummaryMaxChars: number
  /** 每次 run 允许的反应式压缩最大次数。默认 2 */
  maxReactiveCompacts: number
  /** 反应式压缩保留最近的消息条数。默认 2 */
  reactiveCompactKeepCount: number

  // ---- 工具结果预算 ----
  /** 单条工具结果最大字符数。默认 30000 */
  maxToolResultChars: number
  /** 所有工具结果总字符数上限。默认 200000 */
  maxTotalToolResultChars: number

  // ---- 循环检测 ----
  /** 循环检测窗口大小（连续相同调用的判定次数）。默认 3 */
  loopDetectionWindow: number

  // ---- Agent loop ----
  /** 单次 run 最大轮次。默认 25 */
  maxAgentTurns: number
  /** 子代理最大嵌套深度。默认 2 */
  maxSubAgentDepth: number
  /** 单次 run 最大输入 token 数（0 = 不限制）。默认 0 */
  maxBudgetTokens: number

  // ---- 消息管理 ----
  /** 单条消息最大字符数（防止异常工具输出撑爆内存）。默认 100000 */
  maxMessageChars: number

  // ---- Microcompact（旧工具结果清理） ----
  /** 距上次 assistant 消息超过此分钟数触发 microcompact。默认 60 */
  microcompactGapMinutes: number
  /** Microcompact 保留最近 N 个 compactable 工具结果。默认 5 */
  microcompactKeepRecent: number
}

/** 默认配置 */
export const DEFAULT_RUNTIME_CONFIG: AgentRuntimeConfig = {
  compactThreshold: 0,           // 0 = 使用自动公式
  compactSafetyBuffer: 13_000,    // 参考 Claude Code 的 AUTOCOMPACT_BUFFER_TOKENS
  maxConsecutiveCompactFailures: 3,
  compactKeepRatio: 0.25,
  compactKeepMax: 10,
  compactKeepMin: 2,
  compactSummaryMaxChars: 500,
  maxReactiveCompacts: 2,
  reactiveCompactKeepCount: 2,

  maxToolResultChars: 30_000,
  maxTotalToolResultChars: 200_000,

  loopDetectionWindow: 3,

  maxAgentTurns: 25,
  maxSubAgentDepth: 2,
  maxBudgetTokens: 0,  // 0 = 不限制

  maxMessageChars: 100_000,

  microcompactGapMinutes: 60,
  microcompactKeepRecent: 5,
}

/**
 * 创建运行时配置，未指定的字段使用默认值。
 */
export function createRuntimeConfig(
  overrides?: Partial<AgentRuntimeConfig>
): AgentRuntimeConfig {
  return { ...DEFAULT_RUNTIME_CONFIG, ...overrides }
}
