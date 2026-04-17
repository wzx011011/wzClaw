// ============================================================
// 评分聚合 — 将多个任务结果汇总为 RunSummary
// ============================================================

import type { HeadlessConfig, RunSummary, TaskEvalResult } from './types'

export function aggregateScores(
  runName: string,
  datasetName: string,
  config: HeadlessConfig,
  results: TaskEvalResult[],
): RunSummary {
  const total = results.length
  if (total === 0) {
    return {
      runName,
      datasetName,
      model: config.model,
      timestamp: new Date().toISOString(),
      config,
      totalTasks: 0,
      testPassRate: 0,
      avgToolSuccessRate: 0,
      avgTurnsPerTask: 0,
      avgEditSuccessRate: 0,
      avgJudgeTaskCompletion: 0,
      avgJudgeEfficiency: 0,
      perTaskResults: [],
    }
  }

  // Layer A: 测试通过率
  const testedTasks = results.filter(r => r.testPassed !== null)
  const testPassRate = testedTasks.length > 0
    ? testedTasks.filter(r => r.testPassed === true).length / testedTasks.length
    : 0

  // Layer B: 自动指标（从 autoScores 中提取，可能为空如果 Langfuse 拉取失败）
  const avgToolSuccessRate = avg(
    results.map(r => typeof r.autoScores['tool_success_rate'] === 'number'
      ? r.autoScores['tool_success_rate'] as number
      : -1),
  )
  const avgTurnsPerTask = avg(results.map(r => r.turnCount))
  const avgEditSuccessRate = avg(
    results.map(r => typeof r.autoScores['edit_success_rate'] === 'number'
      ? r.autoScores['edit_success_rate'] as number
      : -1),
  )

  // Layer C: Judge 评分
  const avgJudgeTaskCompletion = avg(
    results.map(r => r.judgeScores['task_completion'] ?? -1),
  )
  const avgJudgeEfficiency = avg(
    results.map(r => r.judgeScores['efficiency'] ?? -1),
  )

  return {
    runName,
    datasetName,
    model: config.model,
    timestamp: new Date().toISOString(),
    config,
    totalTasks: total,
    testPassRate,
    avgToolSuccessRate,
    avgTurnsPerTask,
    avgEditSuccessRate,
    avgJudgeTaskCompletion,
    avgJudgeEfficiency,
    perTaskResults: results,
  }
}

/** 计算平均值，忽略 -1 值 */
function avg(values: number[]): number {
  const valid = values.filter(v => v >= 0)
  return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : 0
}
