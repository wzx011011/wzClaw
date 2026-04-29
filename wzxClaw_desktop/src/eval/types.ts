// ============================================================
// 评测系统共享类型定义
// ============================================================

/** 评测数据集中的单个工作区 */
export interface BenchmarkTask {
  id: string
  source: 'aider-polyglot' | 'swebench-verified'
  language: string
  difficulty: 'easy' | 'medium' | 'hard'
  description: string
  /** 起始文件 { relativePath: content } */
  startingFiles: Record<string, string>
  /** 验证命令（如 pytest, go test 等） */
  testCommand?: string
  /** 标准答案 patch（可选） */
  goldPatch?: string
  metadata: {
    category: string
    /** SWE-bench 专有字段 */
    repo?: string
    baseCommit?: string
    instanceId?: string
    /** Train/test 分割标记（用于反过拟合） */
    split?: 'train' | 'test'
  }
}

/** Headless 运行配置 */
export interface HeadlessConfig {
  model: string
  provider: 'openai' | 'anthropic'
  apiKey: string
  baseURL?: string
  maxTurns?: number
  /** 自定义 system prompt（留空使用默认） */
  systemPrompt?: string
  /** 工作区间延迟（毫秒） */
  interTaskDelay?: number
}

/** 单次 headless 运行结果 */
export interface HeadlessRunResult {
  taskId: string
  events: AgentEventRecord[]
  messages: MessageRecord[]
  usage: { inputTokens: number; outputTokens: number }
  turnCount: number
  traceId: string
  duration: number
  /** 工作空间最终 git diff */
  patch?: string
}

/** 轻量级事件记录（避免依赖 main 进程类型） */
export interface AgentEventRecord {
  type: string
  timestamp: number
  [key: string]: unknown
}

/** 轻量级消息记录 */
export interface MessageRecord {
  role: string
  content: string
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>
}

/** 逐工作区 trace 摘要（从事件流提取，用于失败分析） */
export interface TaskTraceData {
  /** 工具调用序列 */
  toolCallSequence: Array<{ tool: string; turn: number; isError: boolean }>
  /** 第一次文件编辑尝试 */
  firstEditAttempt?: { tool: string; turn: number; isError: boolean }
  /** agent 是否在结束前跑了测试命令 */
  ranTestBeforeDone: boolean
  /** 第一次编辑前的文件读取次数 */
  readsBeforeFirstEdit: number
  /** 总错误事件数 */
  errorCount: number
  /** 最后一条 assistant 消息摘要 */
  finalAssistantText: string
  /** 是否触达最大轮次 */
  hitMaxTurns: boolean
  /** 测试输出（仅失败时，max 2000 chars） */
  testOutput?: string
}

/** SWE-bench 风格的失败分类 */
export interface FailureClassification {
  taskId: string
  /** SWE-bench 失败分类 */
  taxonomy: 'localization' | 'repair' | 'iteration' | 'environment' | 'knowledge' | 'unknown'
  /** 具体失败模式 */
  failureMode: string
  /** agent 首次出错的 turn */
  criticalTurn: number
  /** 一句话根因 */
  rootCause: string
  /** 重试是否能改善 */
  recoverable: boolean
  /** 针对性的 prompt 修复建议 */
  suggestedPromptFix: string
  /** 分析来源 */
  analysisSource: 'rule' | 'llm'
}

/** 失败聚类 */
export interface FailureCluster {
  failureMode: string
  taxonomy: string
  taskIds: string[]
  count: number
  /** impact = count * (1 + hardTaskRatio) */
  impact: number
  representativeCause: string
  suggestedFixes: string[]
  priority: number
}

/** 跨工作区诊断指标 */
export interface TraceMetrics {
  /** 失败工作区中没跑测试的比例 */
  noTestRunRate: number
  /** 失败工作区中第一次编辑出错的比例 */
  firstEditFailRate: number
  /** 失败工作区中触达最大轮次的比例 */
  maxTurnsRate: number
  /** 失败工作区中盲目编辑的比例 */
  blindEditRate: number
  /** 成功工作区平均编辑前读取次数 */
  avgReadsBeforeEditSuccess: number
  /** 失败工作区平均编辑前读取次数 */
  avgReadsBeforeEditFailure: number
  /** 有工具错误时最终恢复的比例 */
  toolErrorRecoveryRate: number
}

/** OPRO 优化历史记录 */
export interface OptimizationHistoryEntry {
  iteration: number
  targetedClusters: string[]
  promptDiff: string
  resultPassRate: Record<string, number>
  kept: boolean
}

/** 单个工作区的完整评测结果 */
export interface TaskEvalResult {
  taskId: string
  taskSource: string
  language: string
  difficulty: string
  /** Layer A: 测试执行结果 */
  testPassed: boolean | null  // null = 无测试命令
  testOutput?: string
  /** Layer B: 自动指标（来自 EvalCollector） */
  autoScores: Record<string, number | string>
  /** Layer C: LLM Judge 评分 */
  judgeScores: Record<string, number>
  judgeReasoning?: string
  /** 运行元数据 */
  turnCount: number
  duration: number
  traceId: string
  patch?: string
  error?: string
  /** 逐工作区 trace 摘要（迭代模式下填充） */
  traceData?: TaskTraceData
}
export interface RunSummary {
  runName: string
  datasetName: string
  model: string
  timestamp: string
  config: HeadlessConfig
  totalTasks: number
  /** Layer A */
  testPassRate: number
  /** Layer B */
  avgToolSuccessRate: number
  avgTurnsPerTask: number
  avgEditSuccessRate: number
  /** Layer C */
  avgJudgeTaskCompletion: number
  avgJudgeEfficiency: number
  /** 所有工作区结果 */
  perTaskResults: TaskEvalResult[]
}

/** 弱点报告 */
export interface WeaknessReport {
  runName: string
  timestamp: string
  categories: WeaknessCategory[]
  topRecommendations: string[]
}

export interface WeaknessCategory {
  name: string
  severity: 'critical' | 'warning' | 'info'
  affectedTasks: string[]
  evidence: string
  recommendation: string
}

/** 两次 run 的对比结果 */
export interface ComparisonReport {
  runA: string
  runB: string
  improved: string[]    // task IDs that improved
  regressed: string[]   // task IDs that regressed
  unchanged: string[]   // task IDs with same result
  metricDeltas: Record<string, number>
  summary: string
}

// ---- 自我迭代类型 ----

/** 迭代引擎配置 */
export interface IterationConfig {
  maxIterations: number
  model: string
  provider: 'openai' | 'anthropic'
  apiKey: string
  baseURL: string
  maxTurns: number
  /** 训练集通过率目标 */
  targetPassRate: Record<string, number>  // datasetName -> target (e.g. 0.85)
  /** 每 N 次迭代做一次 test split 验证 */
  validationInterval: number
  /** Judge 配置 */
  judgeConfig?: {
    apiKey: string
    baseURL: string
    judgeModel: string
  }
  /** 连续无改进轮次达到此值时 early stop（默认 3） */
  maxStagnation?: number
  /** 每次评测重复运行次数，取中位数降噪（默认 1，推荐 3） */
  repeatRuns?: number
}

/** 单次迭代记录 */
export interface IterationRecord {
  iteration: number
  timestamp: string
  trainResults: Record<string, RunSummary>  // datasetName -> RunSummary
  testResults?: Record<string, RunSummary>  // 仅在 validation checkpoint 时填充
  weaknessReport?: WeaknessReport
  improved: boolean
  promptChanges: string[]
  currentPassRate: Record<string, number>  // datasetName -> passRate
}

/** 迭代引擎状态（可持久化到 .eval-reports/iteration-state.json） */
export interface IterationState {
  currentIteration: number
  bestPassRate: Record<string, number>  // datasetName -> best passRate
  bestPromptVariant: string
  currentPromptVariant: string
  history: IterationRecord[]
  /** 连续无改进的轮次计数 */
  stagnationCount: number
  /** OPRO 优化历史（含得分和是否被回滚） */
  optimizationHistory: OptimizationHistoryEntry[]
}
