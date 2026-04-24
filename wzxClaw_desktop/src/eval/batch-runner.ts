// ============================================================
// 批量运行器 — 顺序执行数据集中的所有任务
// ============================================================

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { Langfuse } from 'langfuse'
import { runBenchmarkTask, shutdown, extractTraceData } from './headless-runner'
import { prepareWorkspace } from './workspace-isolation'
import { scoreTask } from './scorer'
import { aggregateScores } from './score-aggregator'
import { pullAutoScores } from './auto-score-puller'
import { ensureToolchains, isToolchainAvailable } from './toolchain-resolver'
import type { BenchmarkTask, HeadlessConfig, RunSummary, TaskEvalResult } from './types'

const LANGFUSE_BASE_URL = process.env.LANGFUSE_BASE_URL ?? 'http://192.168.100.78:3000'
const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY ?? 'pk-lf-78a706ff-29b5-49a6-8e68-222b9f88962e'
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY ?? 'sk-lf-ab1adf9a-2420-4d78-ad5e-04b81e633ffb'

export interface BatchRunConfig {
  /** 数据集名称 */
  datasetName: string
  /** 数据文件路径 */
  dataFile: string
  /** 运行名称（区分不同实验） */
  runName: string
  /** Agent 配置 */
  agentConfig: HeadlessConfig
  /** 最多跑几条（0 = 全部） */
  limit?: number
  /** LLM Judge 配置（不设则跳过 judge） */
  judgeConfig?: {
    apiKey: string
    baseURL: string
    judgeModel: string
  }
  /** 是否保留工作空间（用于调试） */
  keepWorkspaces?: boolean
  /** 只运行指定 split 的任务（'train' | 'test'） */
  splitFilter?: 'train' | 'test'
  /** 是否保存 trace 摘要到 TaskEvalResult（迭代模式需要） */
  storeTraceData?: boolean
}

/**
 * 执行一次批量评测
 */
export async function runBatch(config: BatchRunConfig): Promise<RunSummary> {
  const lf = new Langfuse({
    publicKey: LANGFUSE_PUBLIC_KEY,
    secretKey: LANGFUSE_SECRET_KEY,
    baseUrl: LANGFUSE_BASE_URL,
  })

  // 检测工具链并补全 PATH
  const toolchains = ensureToolchains()
  console.log('Toolchain status:')
  console.log(`  Python: ${toolchains.python.available ? toolchains.python.version : 'NOT FOUND'}`)
  console.log(`  Go: ${toolchains.go.available ? toolchains.go.version : 'NOT FOUND'}`)
  console.log(`  Rust: ${toolchains.rust.available ? toolchains.rust.version : 'NOT FOUND'}`)
  console.log(`  JavaScript: ${toolchains.javascript.version}`)

  // 加载数据集
  const raw = readFileSync(resolve(config.dataFile), 'utf-8')
  let tasks: BenchmarkTask[] = JSON.parse(raw)
  if (config.limit && config.limit > 0) {
    tasks = tasks.slice(0, config.limit)
  }

  // 按 train/test split 过滤
  if (config.splitFilter) {
    const before = tasks.length
    tasks = tasks.filter(t => t.metadata.split === config.splitFilter)
    console.log(`Split filter: ${config.splitFilter} (${tasks.length}/${before} tasks)`)
  }

  console.log(`\n=== Batch Run: ${config.runName} ===`)
  console.log(`Dataset: ${config.datasetName} (${tasks.length} tasks)`)
  console.log(`Model: ${config.agentConfig.model}`)
  console.log(`Max turns: ${config.agentConfig.maxTurns ?? 15}\n`)

  const results: TaskEvalResult[] = []
  const startTime = Date.now()

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    console.log(`[${i + 1}/${tasks.length}] ${task.id} (${task.language}/${task.difficulty})...`)

    // 跳过工具链不可用的任务（不浪费 API 调用）
    if (!isToolchainAvailable(task.language)) {
      console.log(`  -> SKIP (${task.language} toolchain not installed)`)
      results.push({
        taskId: task.id,
        taskSource: task.source,
        language: task.language,
        difficulty: task.difficulty,
        testPassed: null,
        testOutput: `Skipped: ${task.language} toolchain not available`,
        autoScores: {},
        judgeScores: {},
        turnCount: 0,
        duration: 0,
        traceId: '',
      })
      continue
    }

    try {
      // 准备工作空间（scorer 和 agent 共用同一目录）
      const workspace = await prepareWorkspace(task)
      const workspaceDir = workspace.workspaceDir

      // 运行 agent（传入 workspaceDir，避免重复创建）
      const runResult = await runBenchmarkTask(task, config.agentConfig, workspaceDir)

      // 评分（A + C 层）— 始终传 workspaceDir 以执行测试
      const evalResult = await scoreTask(
        task,
        runResult,
        workspaceDir,
        config.judgeConfig ?? { apiKey: '', baseURL: '', judgeModel: '' },
      )

      // Layer B: 从 Langfuse 拉取 EvalCollector 自动采集的评分
      try {
        const autoScores = await pullAutoScores(lf, runResult.traceId)
        if (Object.keys(autoScores).length > 0) {
          evalResult.autoScores = autoScores
        }
      } catch {
        // auto score 拉取失败不影响评测
      }

      // 关联到 Langfuse dataset run（v3 SDK api 属性）
      try {
        await lf.api.datasetRunItemsCreate({
          runName: config.runName,
          datasetItemId: task.id,
          traceId: runResult.traceId,
        })
      } catch {
        // dataset run 关联失败不影响评测
      }

      // 推送评分到 Langfuse trace（v3 SDK api 属性）
      for (const [name, value] of Object.entries(evalResult.judgeScores)) {
        if (value > 0) {
          try {
            await lf.api.scoresCreate({
              traceId: runResult.traceId,
              name: `judge_${name}`,
              value,
              dataType: 'NUMERIC',
            })
          } catch { /* ignore */ }
        }
      }

      if (evalResult.testPassed !== null) {
        try {
          await lf.api.scoresCreate({
            traceId: runResult.traceId,
            name: 'test_passed',
            value: evalResult.testPassed ? 1 : 0,
            dataType: 'NUMERIC',
          })
        } catch { /* ignore */ }
      }

      results.push(evalResult)

      // 提取 trace 摘要（迭代模式需要，用于逐任务失败分析）
      if (config.storeTraceData) {
        evalResult.traceData = extractTraceData(
          runResult.events,
          runResult.messages,
          task.testCommand,
          evalResult.testOutput,
        )
      }

      // 输出进度
      const status = evalResult.testPassed === true ? 'PASS' : evalResult.testPassed === false ? 'FAIL' : 'N/A'
      console.log(`  -> ${status} | ${runResult.turnCount} turns | ${(runResult.duration / 1000).toFixed(1)}s`)

      // 清理工作空间
      if (!config.keepWorkspaces) {
        await workspace.cleanup().catch(() => {})
      }

      // 任务间延迟（避免限流）
      const delay = config.agentConfig.interTaskDelay ?? 3000
      if (i < tasks.length - 1 && delay > 0) {
        await new Promise(r => setTimeout(r, delay))
      }
    } catch (err: any) {
      console.error(`  -> ERROR: ${err.message}`)
      results.push({
        taskId: task.id,
        taskSource: task.source,
        language: task.language,
        difficulty: task.difficulty,
        testPassed: null,
        autoScores: {},
        judgeScores: {},
        turnCount: 0,
        duration: 0,
        traceId: '',
        error: err.message,
      })
    }
  }

  // 聚合
  const summary = aggregateScores(config.runName, config.datasetName, config.agentConfig, results)
  summary.timestamp = new Date().toISOString()

  // 确保 Langfuse 写入（只 flush，不 shutdown — 调用方负责 shutdown）
  await lf.flushAsync()

  console.log(`\n=== Run Complete ===`)
  console.log(`Tasks: ${results.length}`)
  console.log(`Test Pass Rate: ${(summary.testPassRate * 100).toFixed(0)}%`)
  console.log(`Avg Turns: ${summary.avgTurnsPerTask.toFixed(1)}`)
  console.log(`Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`)

  return summary
}
