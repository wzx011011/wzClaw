// ============================================================
// 评测系统共享类型定义
// ============================================================

/** 评测数据集中的单个任务 */
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
  /** 任务间延迟（毫秒） */
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

/** 单个任务的完整评测结果 */
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
}

/** 一次完整 run 的聚合结果 */
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
  /** 所有任务结果 */
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
}
