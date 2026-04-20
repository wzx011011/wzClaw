// ============================================================
// Expert-Executor — 对可恢复的失败任务生成纠正策略并重试
// 策略累积到 StrategyBook，跨迭代复用
// ============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { runBenchmarkTask } from './headless-runner'
import type { BenchmarkTask, HeadlessConfig, HeadlessRunResult, FailureClassification, TaskTraceData } from './types'

const STRATEGY_BOOK_PATH = '.eval-reports/strategy-book.json'
const MAX_RETRIES_PER_ITERATION = 5
const MIN_SUCCESS_RATE = 0.1 // 低于此比例自动禁用

export interface StrategyBookEntry {
  failureMode: string
  taxonomy: string
  strategy: string
  successCount: number
  failureCount: number
}

interface StrategyBook {
  entries: StrategyBookEntry[]
  totalRetries: number
  totalSuccesses: number
}

export class ExpertExecutor {
  private book: StrategyBook
  private retriesThisIteration = 0

  constructor() {
    this.book = this.loadBook()
  }

  /**
   * 对可恢复的失败任务执行 Expert-Executor 重试
   * 返回成功重试的 task IDs
   */
  async retryRecoverable(
    tasks: BenchmarkTask[],
    classifications: FailureClassification[],
    agentConfig: HeadlessConfig,
    llmConfig: { apiKey: string; baseURL: string; model: string },
  ): Promise<string[]> {
    const recoverable = classifications.filter(c =>
      c.recoverable && c.analysisSource !== 'unknown'
    )

    if (recoverable.length === 0) {
      console.log('  No recoverable failures to retry.')
      return []
    }

    // 检查整体成功率，太低则跳过
    if (this.book.totalRetries > 10 &&
        this.book.totalSuccesses / this.book.totalRetries < MIN_SUCCESS_RATE) {
      console.log('  Expert-Executor disabled: success rate too low.')
      return []
    }

    const succeeded: string[] = []
    const toRetry = recoverable.slice(0, MAX_RETRIES_PER_ITERATION - this.retriesThisIteration)

    console.log(`  Retrying ${toRetry.length} recoverable tasks...`)

    for (const cls of toRetry) {
      const task = tasks.find(t => t.id === cls.taskId)
      if (!task) continue

      this.retriesThisIteration++

      try {
        // 1. 查找已有策略或生成新策略
        const strategy = this.findStrategy(cls) ??
          await this.generateStrategy(task, cls, llmConfig)

        if (!strategy) {
          console.log(`    ${cls.taskId}: could not generate strategy, skipping`)
          continue
        }

        // 2. 注入策略到 task description
        const enhancedTask: BenchmarkTask = {
          ...task,
          description: `[CORRECTIVE GUIDANCE]\n${strategy}\n\n[ORIGINAL TASK]\n${task.description}`,
        }

        // 3. 重新运行
        console.log(`    ${cls.taskId}: retrying with strategy...`)
        const result = await runBenchmarkTask(enhancedTask, agentConfig)

        // 4. 简单判断是否成功（基于是否有 patch）
        const hasPatch = result.patch && result.patch.length > 10
        if (hasPatch) {
          succeeded.push(cls.taskId)
          this.recordStrategyResult(cls.failureMode, cls.taxonomy, strategy, true)
          console.log(`    ${cls.taskId}: RETRY SUCCESS`)
        } else {
          this.recordStrategyResult(cls.failureMode, cls.taxonomy, strategy, false)
          console.log(`    ${cls.taskId}: retry did not improve`)
        }
      } catch (err: any) {
        console.log(`    ${cls.taskId}: retry error: ${err.message}`)
        this.book.totalRetries++
      }
    }

    this.saveBook()
    return succeeded
  }

  /** 重置每轮计数器 */
  resetIteration(): void {
    this.retriesThisIteration = 0
  }

  /** 查找已有策略 */
  private findStrategy(cls: FailureClassification): string | null {
    const entry = this.book.entries.find(
      e => e.failureMode === cls.failureMode && e.taxonomy === cls.taxonomy && e.successCount > 0
    )
    return entry?.strategy ?? null
  }

  /** 用 LLM 生成纠正策略 */
  private async generateStrategy(
    task: BenchmarkTask,
    cls: FailureClassification,
    config: { apiKey: string; baseURL: string; model: string },
  ): Promise<string | null> {
    const prompt = `A coding agent failed this task. Generate a concise corrective strategy.

Failure analysis:
- Taxonomy: ${cls.taxonomy}
- Failure mode: ${cls.failureMode}
- Root cause: ${cls.rootCause}
- Critical turn: ${cls.criticalTurn}

Task description:
${task.description.slice(0, 500)}

Generate 2-4 concrete steps the agent should follow to avoid this failure.
Be specific and actionable. Do NOT repeat generic advice.

Strategy:`

    try {
      const url = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(30_000),
      })

      if (!resp.ok) return null
      const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
      const content = data.choices?.[0]?.message?.content?.trim()
      return content && content.length > 20 ? content : null
    } catch {
      return null
    }
  }

  /** 记录策略结果 */
  private recordStrategyResult(
    failureMode: string,
    taxonomy: string,
    strategy: string,
    success: boolean,
  ): void {
    let entry = this.book.entries.find(
      e => e.failureMode === failureMode && e.strategy === strategy
    )

    if (!entry) {
      entry = { failureMode, taxonomy, strategy, successCount: 0, failureCount: 0 }
      this.book.entries.push(entry)
    }

    if (success) entry.successCount++
    else entry.failureCount++
    this.book.totalRetries++
    if (success) this.book.totalSuccesses++
  }

  private loadBook(): StrategyBook {
    const path = resolve(STRATEGY_BOOK_PATH)
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf-8'))
      } catch { /* corrupted */ }
    }
    return { entries: [], totalRetries: 0, totalSuccesses: 0 }
  }

  private saveBook(): void {
    const path = resolve(STRATEGY_BOOK_PATH)
    const dir = resolve('.eval-reports')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(this.book, null, 2))
  }
}
