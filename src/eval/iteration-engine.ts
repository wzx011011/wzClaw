// ============================================================
// 迭代引擎 — 自动化 评测 → 分析 → 修复 → 再评测 闭环
// ============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { Langfuse } from 'langfuse'
import { runBatch } from './batch-runner'
import { analyzeWeaknesses } from './weakness-analyzer'
import { compareRuns } from './comparison-report'
import { optimizePrompt, stripOptimizations } from './prompt-optimizer'
import { optimizePromptWithLLM } from './llm-prompt-optimizer'
import { AgentOptimizer } from './agent-optimizer'
import { writeImprovementChangelog } from './improvement-changelog'
import { compareStratified, formatStratifiedReport } from './stratified-tracker'
import { ELORanking } from './elo-ranking'
import { analyzeTaskFailure } from './trace-analyzer'
import { computeTraceMetrics, formatTraceMetrics } from './trace-metrics'
import { clusterFailures, formatClusterSummary } from './failure-clusterer'
import { generatePromptWithOPRO } from './opro-optimizer'
import { ExpertExecutor } from './expert-executor'
import type {
  IterationConfig,
  IterationState,
  IterationRecord,
  RunSummary,
  WeaknessReport,
  FailureClassification,
  FailureCluster,
  TraceMetrics,
  TaskEvalResult,
  BenchmarkTask,
} from './types'

const DATASETS = {
  'aider-polyglot': {
    name: 'aider-polyglot-regression',
    file: 'data/eval/aider-polyglot-curated.json',
  },
  'swebench-curated': {
    name: 'swebench-verified-curated',
    file: 'data/eval/swebench-verified-curated.json',
  },
} as const

type DatasetKey = keyof typeof DATASETS

const STATE_FILE = '.eval-reports/iteration-state.json'
const BASE_IMPROVEMENT_THRESHOLD = 0.02  // 基准阈值，会根据样本量动态调整

export class IterationEngine {
  private config: IterationConfig
  private state: IterationState
  private basePrompt: string
  private agentOptimizer: AgentOptimizer
  private eloRanking: ELORanking
  private expertExecutor: ExpertExecutor

  constructor(config: IterationConfig) {
    this.config = config

    // 加载默认 system prompt
    this.basePrompt = this.loadDefaultPrompt()

    // 代码优化器（带回滚）
    this.agentOptimizer = new AgentOptimizer()

    // 加载或初始化状态
    this.state = this.loadState()

    // ELO 排名系统
    this.eloRanking = this.loadELORanking()

    // Expert-Executor 重试引擎
    this.expertExecutor = new ExpertExecutor()
  }

  async run(): Promise<void> {
    console.log('\n' + '='.repeat(60))
    console.log('wzxClaw Self-Iteration Engine')
    console.log('='.repeat(60))
    console.log(`Max iterations: ${this.config.maxIterations}`)
    console.log(`Target pass rates: ${JSON.stringify(this.config.targetPassRate)}`)
    console.log(`Validation interval: every ${this.config.validationInterval} iterations`)
    console.log(`Max stagnation: ${this.config.maxStagnation ?? 3} iterations`)
    console.log(`Repeat runs per eval: ${this.config.repeatRuns ?? 1} (median selection)`)
    console.log('='.repeat(60) + '\n')

    for (let i = this.state.currentIteration; i < this.config.maxIterations; i++) {
      console.log(`\n${'─'.repeat(50)}`)
      console.log(`ITERATION ${i + 1}/${this.config.maxIterations}`)
      console.log(`${'─'.repeat(50)}`)

      // 1. Run train split on both datasets (median of repeatRuns if configured)
      console.log('\n[Step 1] Running train split evaluation...')
      const trainResults = await this.runTrainSplitWithRepeat()

      // 2. Calculate current pass rates
      const currentPassRate: Record<string, number> = {}
      for (const [ds, summary] of Object.entries(trainResults)) {
        currentPassRate[ds] = summary.testPassRate
      }

      // 3. Analyze weaknesses
      console.log('\n[Step 2] Analyzing weaknesses...')
      const weaknessReport = this.analyzeAll(trainResults)

      // 4. Check if target met
      const targetMet = this.checkTargets(currentPassRate)
      if (targetMet) {
        console.log('\n✓ TARGET MET! All pass rates reached target thresholds.')
        this.saveIteration(i, trainResults, undefined, weaknessReport, currentPassRate, true)
        break
      }

      // 5. Per-task trace analysis
      console.log('\n[Step 2b] Analyzing per-task failures...')
      const { classifications, clusters, metrics } = await this.analyzeTaskFailures(trainResults)

      // 6. Print failure diagnostics
      console.log('\n[Step 2c] Failure clusters:')
      console.log(formatClusterSummary(clusters))
      console.log('\n[Step 2d] Trace metrics:')
      console.log(formatTraceMetrics(metrics))

      // 7. Optimize prompt — OPRO first, fallback to static
      console.log('\n[Step 3] Optimizing system prompt...')
      let changes: string[] = []

      if (clusters.length > 0 && this.config.judgeConfig) {
        const oproResult = await generatePromptWithOPRO(
          this.state.currentPromptVariant,
          clusters,
          this.state.optimizationHistory,
          {
            apiKey: this.config.judgeConfig.apiKey,
            baseURL: this.config.judgeConfig.baseURL,
            model: this.config.judgeConfig.judgeModel,
          },
        )
        if (oproResult.changes.length > 0) {
          this.state.currentPromptVariant = oproResult.prompt
          changes = oproResult.changes
          console.log(`OPRO applied: ${oproResult.rationale}`)
        } else {
          console.log(`OPRO: ${oproResult.rationale}`)
          changes = this.fallbackToStaticOptimization(weaknessReport)
        }
      } else {
        changes = this.fallbackToStaticOptimization(weaknessReport)
      }

      // 7b. Optimize agent code (file-edit, loop-detector, stall detection)
      console.log('\n[Step 3b] Optimizing agent code...')
      const codeChanges = await this.agentOptimizer.optimize(weaknessReport)
      if (codeChanges.length > 0) {
        console.log(`Applied ${codeChanges.length} code optimizations: ${codeChanges.join('; ')}`)
      } else {
        console.log('No code optimizations applicable.')
      }

      // 7c. Expert-Executor retry for recoverable failures
      if (classifications.some(c => c.recoverable) && this.config.judgeConfig) {
        console.log('\n[Step 3c] Expert-Executor retry...')
        this.expertExecutor.resetIteration()
        // Load tasks for retry
        const allTasks = this.loadAllTasks()
        await this.expertExecutor.retryRecoverable(
          allTasks,
          classifications,
          {
            model: this.config.model,
            provider: this.config.provider,
            apiKey: this.config.apiKey,
            baseURL: this.config.baseURL ?? '',
            maxTurns: this.config.maxTurns,
            systemPrompt: this.state.currentPromptVariant,
          },
          {
            apiKey: this.config.judgeConfig.apiKey,
            baseURL: this.config.judgeConfig.baseURL,
            model: this.config.judgeConfig.judgeModel,
          },
        )
      }

      // 8. Re-run train split with new prompt (median of repeatRuns if configured)
      console.log('\n[Step 4] Re-running train split with optimized prompt...')
      const newTrainResults = await this.runTrainSplitWithRepeat(this.state.currentPromptVariant)

      const newPassRate: Record<string, number> = {}
      for (const [ds, summary] of Object.entries(newTrainResults)) {
        newPassRate[ds] = summary.testPassRate
      }

      // 7. Compare with historical best (not current iteration baseline)
      const improved = this.isImproved(this.state.bestPassRate, newPassRate)

      if (improved) {
        console.log('\n✓ IMPROVED! Updating best results.')

        // Record optimization history
        this.state.optimizationHistory.push({
          iteration: i + 1,
          targetedClusters: clusters.slice(0, 3).map(c => c.failureMode),
          promptDiff: changes.join('; '),
          resultPassRate: newPassRate,
          kept: true,
        })

        // 写入改进变更日志
        const oldPromptSnapshot = this.state.bestPromptVariant
        writeImprovementChangelog({
          iteration: i,
          oldPassRates: { ...this.state.bestPassRate },
          newPassRates: newPassRate,
          oldPrompt: oldPromptSnapshot,
          newPrompt: this.state.currentPromptVariant,
          promptChanges: changes,
          codeChanges,
          oldTrainResults: trainResults,
          newTrainResults,
          weaknessReport,
          state: this.state,
        })

        for (const [ds, rate] of Object.entries(newPassRate)) {
          this.state.bestPassRate[ds] = rate
        }
        this.state.bestPromptVariant = this.state.currentPromptVariant
        this.state.stagnationCount = 0
        // 代码优化保留（已验证编译通过且效果提升）
      } else {
        console.log('\n✗ No improvement. Rolling back prompt and code changes.')

        // Record optimization history (rolled back)
        this.state.optimizationHistory.push({
          iteration: i + 1,
          targetedClusters: clusters.slice(0, 3).map(c => c.failureMode),
          promptDiff: changes.join('; '),
          resultPassRate: newPassRate,
          kept: false,
        })

        this.state.currentPromptVariant = this.state.bestPromptVariant
        // 回滚代码优化
        await this.agentOptimizer.rollback()
        this.state.stagnationCount++
        console.log(`  Stagnation count: ${this.state.stagnationCount}/${this.config.maxStagnation ?? 3}`)
      }

      // 7b. Stratified degradation check
      console.log('\n[Step 5] Stratified evaluation...')
      for (const [ds, newSummary] of Object.entries(newTrainResults)) {
        const oldSummary = trainResults[ds]
        if (!oldSummary) continue
        const stratReport = compareStratified(oldSummary, newSummary)
        if (stratReport.hasStratifiedDegradation) {
          console.log(`  ⚠ ${ds}: ${stratReport.degradedStrata.length} strata degraded:`)
          for (const d of stratReport.degradedStrata) {
            console.log(`    ${d.dimension}=${d.value}: ${(d.oldPassRate * 100).toFixed(0)}% → ${(d.newPassRate * 100).toFixed(0)}%`)
          }
        } else {
          console.log(`  ${ds}: No stratified degradation`)
        }
      }

      // 7c. ELO ranking update
      const oldPlayerId = `v${i + 1}-before`
      const newPlayerId = `v${i + 1}-after`
      this.eloRanking.registerPlayer(oldPlayerId, i)
      this.eloRanking.registerPlayer(newPlayerId, i)
      for (const [ds, newSummary] of Object.entries(newTrainResults)) {
        const oldSummary = trainResults[ds]
        if (oldSummary) {
          this.eloRanking.recordRunComparison(newPlayerId, newSummary, oldPlayerId, oldSummary)
        }
      }
      this.saveELORanking()

      // 7d. Early stop if stagnation limit reached
      const maxStag = this.config.maxStagnation ?? 3
      if (this.state.stagnationCount >= maxStag) {
        console.log(`\n⚠ STAGNATION: No improvement for ${maxStag} consecutive iterations. Stopping.`)
        this.saveIteration(i, trainResults, undefined, weaknessReport, newPassRate, improved)
        this.state.currentIteration = i + 1
        this.saveState()
        break
      }

      // 8. Validation checkpoint (every N iterations)
      let testResults: Record<string, RunSummary> | undefined
      if ((i + 1) % this.config.validationInterval === 0) {
        console.log(`\n[Validation Checkpoint] Running test split...`)
        testResults = await this.runTestSplit()

        // Overfitting detection
        const overfitting = this.detectOverfitting(currentPassRate, newPassRate, testResults)
        if (overfitting) {
          console.log('\n⚠ OVERFITTING DETECTED! Train improved but test degraded.')
          console.log('Pausing for manual review.')
          this.saveIteration(i, trainResults, testResults, weaknessReport, newPassRate, improved)
          this.saveState()
          break
        }
      }

      // 9. Save iteration record
      this.saveIteration(i, trainResults, testResults, weaknessReport, newPassRate, improved)
      this.state.currentIteration = i + 1
      this.saveState()

      // Print summary (compare against historical best, not this-run baseline)
      this.printIterationSummary(i, this.state.bestPassRate, newPassRate, improved, changes)
    }

    // Print ELO leaderboard
    const leaderboard = this.eloRanking.formatLeaderboard()
    if (leaderboard) {
      console.log('\n' + leaderboard)
    }

    console.log('\n' + '='.repeat(60))
    console.log('Iteration complete.')
    console.log(`Best pass rates: ${JSON.stringify(this.state.bestPassRate)}`)
    console.log('='.repeat(60))

    // 所有迭代完成后关闭全局资源
    const { shutdown } = await import('./headless-runner')
    await shutdown()
  }

  // ---- Private methods ----

  /**
   * 多次运行 train split 取中位数结果，降低 LLM 随机性噪声
   * repeatRuns=1 时退化为单次运行（向后兼容）
   */
  private async runTrainSplitWithRepeat(customPrompt?: string): Promise<Record<string, RunSummary>> {
    const repeats = this.config.repeatRuns ?? 1
    if (repeats <= 1) return this.runTrainSplit(customPrompt)

    console.log(`  Running ${repeats} repeats for noise reduction...`)
    const allRuns: Record<string, RunSummary>[] = []

    for (let r = 0; r < repeats; r++) {
      console.log(`  [Repeat ${r + 1}/${repeats}]`)
      const entries = Object.entries(DATASETS)
      const summaries = await Promise.all(entries.map(([key, ds]) => runBatch({
        datasetName: ds.name,
        dataFile: resolve(ds.file),
        runName: `iterate-train-${key}-r${r + 1}`,
        agentConfig: {
          model: this.config.model,
          provider: this.config.provider,
          apiKey: this.config.apiKey,
          baseURL: this.config.baseURL,
          maxTurns: this.config.maxTurns,
          systemPrompt: customPrompt ?? this.state.currentPromptVariant,
        },
        splitFilter: 'train',
        judgeConfig: this.config.judgeConfig,
        storeTraceData: true,
      })))
      const results: Record<string, RunSummary> = {}
      entries.forEach(([key], i) => { results[key] = summaries[i] })
      allRuns.push(results)
    }

    // 选出 median：按平均 testPassRate 排序，取中间那个
    allRuns.sort((a, b) => {
      const avgA = Object.values(a).reduce((s, r) => s + r.testPassRate, 0) / Object.values(a).length
      const avgB = Object.values(b).reduce((s, r) => s + r.testPassRate, 0) / Object.values(b).length
      return avgA - avgB
    })
    const medianIdx = Math.floor(allRuns.length / 2)
    const median = allRuns[medianIdx]
    const medianRate = Object.values(median).reduce((s, r) => s + r.testPassRate, 0) / Object.values(median).length
    console.log(`  Median selected: run ${medianIdx + 1} (avg pass rate: ${(medianRate * 100).toFixed(1)}%)`)
    return median
  }

  private async runTrainSplit(customPrompt?: string): Promise<Record<string, RunSummary>> {
    // Clean up previous iteration's train runs
    const trainRunNames = Object.keys(DATASETS).map(key => `iterate-train-${key}`)
    await this.cleanupPreviousRuns(trainRunNames)

    const entries = Object.entries(DATASETS)
    const summaries = await Promise.all(entries.map(([key, ds]) => runBatch({
      datasetName: ds.name,
      dataFile: resolve(ds.file),
      runName: `iterate-train-${key}`,
      agentConfig: {
        model: this.config.model,
        provider: this.config.provider,
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        maxTurns: this.config.maxTurns,
        systemPrompt: customPrompt ?? this.state.currentPromptVariant,
      },
      splitFilter: 'train',
      judgeConfig: this.config.judgeConfig,
      storeTraceData: true,
    })))
    const results: Record<string, RunSummary> = {}
    entries.forEach(([key], i) => { results[key] = summaries[i] })
    return results
  }

  private async runTestSplit(): Promise<Record<string, RunSummary>> {
    // Clean up previous iteration's test runs
    const testRunNames = Object.keys(DATASETS).map(key => `iterate-test-${key}`)
    await this.cleanupPreviousRuns(testRunNames)

    const entries = Object.entries(DATASETS)
    const summaries = await Promise.all(entries.map(([key, ds]) => runBatch({
      datasetName: ds.name,
      dataFile: resolve(ds.file),
      runName: `iterate-test-${key}`,
      agentConfig: {
        model: this.config.model,
        provider: this.config.provider,
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        maxTurns: this.config.maxTurns,
        systemPrompt: this.state.bestPromptVariant,
      },
      splitFilter: 'test',
      judgeConfig: this.config.judgeConfig,
    })))
    const results: Record<string, RunSummary> = {}
    entries.forEach(([key], i) => { results[key] = summaries[i] })
    return results
  }

  private analyzeAll(trainResults: Record<string, RunSummary>): WeaknessReport {
    // 合并所有数据集的弱点分析
    const allCategories: WeaknessReport['categories'] = []
    const allRecommendations: string[] = []

    for (const [ds, summary] of Object.entries(trainResults)) {
      const report = analyzeWeaknesses(summary)
      allCategories.push(...report.categories)
      allRecommendations.push(...report.topRecommendations)
    }

    return {
      runName: `iterate-v${this.state.currentIteration + 1}`,
      timestamp: new Date().toISOString(),
      categories: allCategories,
      topRecommendations: [...new Set(allRecommendations)].slice(0, 5),
    }
  }

  private async analyzeTaskFailures(
    trainResults: Record<string, RunSummary>,
  ): Promise<{ classifications: FailureClassification[]; clusters: FailureCluster[]; metrics: TraceMetrics }> {
    const allClassifications: FailureClassification[] = []
    const allResults: TaskEvalResult[] = []

    const llmConfig = this.config.judgeConfig
      ? { apiKey: this.config.judgeConfig.apiKey, baseURL: this.config.judgeConfig.baseURL, model: this.config.judgeConfig.judgeModel }
      : undefined

    for (const summary of Object.values(trainResults)) {
      allResults.push(...summary.perTaskResults)

      // 对每个失败且有 traceData 的任务进行分析
      const failed = summary.perTaskResults.filter(r => r.testPassed === false && r.traceData)
      for (const result of failed) {
        const cls = await analyzeTaskFailure(
          '', // task description not stored in TaskEvalResult — use empty
          result,
          result.traceData!,
          llmConfig,
        )
        allClassifications.push(cls)
      }
    }

    const clusters = clusterFailures(allClassifications, allResults)
    const metrics = computeTraceMetrics(allResults)

    return { classifications: allClassifications, clusters, metrics }
  }

  private fallbackToStaticOptimization(weaknessReport: WeaknessReport): string[] {
    const { prompt: newPrompt, changes } = optimizePrompt(
      this.state.currentPromptVariant,
      weaknessReport,
    )

    if (changes.length > 0) {
      this.state.currentPromptVariant = newPrompt
      console.log(`Static fallback: ${changes.join(', ')}`)
    }
    return changes
  }

  private async cleanupPreviousRuns(runNames: string[]): Promise<void> {
    const lf = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? '',
      secretKey: process.env.LANGFUSE_SECRET_KEY ?? '',
      baseUrl: process.env.LANGFUSE_BASE_URL ?? 'http://192.168.100.78:3000',
    })

    for (const ds of Object.values(DATASETS)) {
      try {
        const runs = await lf.api.datasetsGetRuns({ datasetName: ds.name })
        for (const run of runs.data ?? []) {
          if (runNames.includes(run.name)) {
            try {
              await lf.api.datasetsDeleteRun(ds.name, run.name)
              console.log(`  Cleaned up old run: ${run.name} from ${ds.name}`)
            } catch { /* ignore */ }
          }
        }
      } catch { /* dataset may not exist yet */ }
    }

    await lf.flushAsync()
  }

  private loadAllTasks(): BenchmarkTask[] {
    const allTasks: BenchmarkTask[] = []
    for (const ds of Object.values(DATASETS)) {
      try {
        const raw = readFileSync(resolve(ds.file), 'utf-8')
        allTasks.push(...JSON.parse(raw))
      } catch { /* skip missing datasets */ }
    }
    return allTasks
  }

  private checkTargets(passRates: Record<string, number>): boolean {
    for (const [ds, target] of Object.entries(this.config.targetPassRate)) {
      const actual = passRates[ds] ?? 0
      if (actual < target) return false
    }
    return true
  }

  private isImproved(
    oldRates: Record<string, number>,
    newRates: Record<string, number>,
  ): boolean {
    // 空基线：任何正向结果都是改进
    if (Object.keys(oldRates).length === 0) {
      const newAvg = this.averageRate(newRates)
      console.log(`  Improvement check: baseline → ${(newAvg * 100).toFixed(1)}% (first run, any positive = improved)`)
      return newAvg > 0
    }
    // 动态阈值：基于样本量的 Wilson interval 近似 Δ > 2/√n
    const threshold = this.dynamicThreshold()
    const oldAvg = this.averageRate(oldRates)
    const newAvg = this.averageRate(newRates)
    console.log(`  Improvement check: ${(oldAvg * 100).toFixed(1)}% → ${(newAvg * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(1)}%)`)
    return newAvg > oldAvg + threshold
  }

  private detectOverfitting(
    oldTrainRates: Record<string, number>,
    newTrainRates: Record<string, number>,
    testResults: Record<string, RunSummary>,
  ): boolean {
    // 检查：train 提升但 test 下降
    const trainImproved = this.averageRate(newTrainRates) > this.averageRate(oldTrainRates)
    const threshold = this.dynamicThreshold()

    let testDegraded = false
    const testRates: Record<string, number> = {}
    for (const [ds, summary] of Object.entries(testResults)) {
      testRates[ds] = summary.testPassRate
    }

    // 对比 test 与历史 best
    for (const [ds, rate] of Object.entries(testRates)) {
      const bestRate = this.state.bestPassRate[ds] ?? 0
      if (rate < bestRate - threshold) {
        testDegraded = true
      }
    }

    return trainImproved && testDegraded
  }

  /**
   * 动态改进阈值：max(BASE_THRESHOLD, 2 / √n)
   * 参考 Wilson confidence interval 的简化形式
   * n = 最近一次已知的平均样本量（从 history 或 DATASETS 估算）
   */
  private dynamicThreshold(): number {
    // 从最近的 history 获取样本量
    const lastRecord = this.state.history[this.state.history.length - 1]
    let avgSampleSize = 40 // 默认估计
    if (lastRecord?.trainResults) {
      const sizes = Object.values(lastRecord.trainResults).map(r => r.totalTasks)
      if (sizes.length > 0) {
        avgSampleSize = sizes.reduce((a, b) => a + b, 0) / sizes.length
      }
    }
    const statistical = 2 / Math.sqrt(avgSampleSize)
    return Math.max(BASE_IMPROVEMENT_THRESHOLD, statistical)
  }

  private averageRate(rates: Record<string, number>): number {
    const values = Object.values(rates)
    if (values.length === 0) return 0
    return values.reduce((a, b) => a + b, 0) / values.length
  }

  private saveIteration(
    iteration: number,
    trainResults: Record<string, RunSummary>,
    testResults: Record<string, RunSummary> | undefined,
    weaknessReport: WeaknessReport,
    passRates: Record<string, number>,
    improved: boolean,
  ): void {
    const record: IterationRecord = {
      iteration: iteration + 1,
      timestamp: new Date().toISOString(),
      trainResults,
      testResults,
      weaknessReport,
      improved,
      promptChanges: this.getPromptChanges(),
      currentPassRate: passRates,
    }
    this.state.history.push(record)
  }

  private getPromptChanges(): string[] {
    const current = this.state.currentPromptVariant
    const base = this.basePrompt
    if (current === base) return []
    // 提取标记的变更
    const markers = current.match(/\/\* EVAL-OPT: (\w+) \*\//g) ?? []
    return markers.map(m => m.replace(/\/\* EVAL-OPT: (\w+) \*\//, '$1'))
  }

  private printIterationSummary(
    iteration: number,
    oldRates: Record<string, number>,
    newRates: Record<string, number>,
    improved: boolean,
    changes: string[],
  ): void {
    console.log(`\n── Iteration ${iteration + 1} Summary ──`)
    for (const ds of Object.keys(newRates)) {
      const old = ((oldRates[ds] ?? 0) * 100).toFixed(0)
      const now = ((newRates[ds] ?? 0) * 100).toFixed(0)
      const target = ((this.config.targetPassRate[ds] ?? 0) * 100).toFixed(0)
      console.log(`  ${ds}: ${old}% → ${now}% (target: ${target}%)`)
    }
    console.log(`  Prompt changes: ${changes.length > 0 ? changes.join(', ') : 'none'}`)
    console.log(`  Result: ${improved ? 'IMPROVED ✓' : 'NO CHANGE ✗'}`)
  }

  private loadDefaultPrompt(): string {
    // 从 constants.ts 加载默认 system prompt
    try {
      // 动态导入避免循环依赖
      const constants = require('../shared/constants')
      return constants.DEFAULT_SYSTEM_PROMPT ?? 'You are a helpful coding assistant.'
    } catch {
      return 'You are a helpful coding assistant.'
    }
  }

  private loadState(): IterationState {
    const statePath = resolve(STATE_FILE)
    if (existsSync(statePath)) {
      try {
        const saved = JSON.parse(readFileSync(statePath, 'utf-8'))
        console.log(`Resuming from iteration ${saved.currentIteration}`)
        // Backfill stagnationCount for old state files
        if (saved.stagnationCount === undefined) saved.stagnationCount = 0
        if (saved.optimizationHistory === undefined) saved.optimizationHistory = []
        if (!saved.currentPromptVariant) saved.currentPromptVariant = saved.bestPromptVariant ?? this.basePrompt
        return saved
      } catch {
        // corrupted state, start fresh
      }
    }
    return {
      currentIteration: 0,
      bestPassRate: {},
      bestPromptVariant: this.basePrompt,
      currentPromptVariant: this.basePrompt,
      history: [],
      stagnationCount: 0,
      optimizationHistory: [],
    }
  }

  private saveState(): void {
    const statePath = resolve(STATE_FILE)
    writeFileSync(statePath, JSON.stringify(this.state, null, 2))
  }

  private loadELORanking(): ELORanking {
    const eloPath = resolve('.eval-reports/elo-state.json')
    if (existsSync(eloPath)) {
      try {
        const data = JSON.parse(readFileSync(eloPath, 'utf-8'))
        return ELORanking.deserialize(data)
      } catch {
        // corrupted, start fresh
      }
    }
    return new ELORanking()
  }

  private saveELORanking(): void {
    const eloPath = resolve('.eval-reports/elo-state.json')
    const dir = resolve('.eval-reports')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(eloPath, JSON.stringify(this.eloRanking.serialize(), null, 2))
  }
}
