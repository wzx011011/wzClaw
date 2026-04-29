// ============================================================
// 对比报告 — 比较两次 run 的结果差异
// ============================================================

import type { RunSummary, ComparisonReport, TaskEvalResult } from './types'

/**
 * 对比两次 run 的结果
 */
export function compareRuns(summaryA: RunSummary, summaryB: RunSummary): ComparisonReport {
  const resultsA = indexByTaskId(summaryA.perTaskResults)
  const resultsB = indexByTaskId(summaryB.perTaskResults)

  const allTaskIds = new Set([...Object.keys(resultsA), ...Object.keys(resultsB)])
  const improved: string[] = []
  const regressed: string[] = []
  const unchanged: string[] = []

  for (const id of allTaskIds) {
    const a = resultsA[id]
    const b = resultsB[id]
    if (!a || !b) continue

    const scoreA = taskScore(a)
    const scoreB = taskScore(b)

    if (scoreB > scoreA) {
      improved.push(id)
    } else if (scoreB < scoreA) {
      regressed.push(id)
    } else {
      unchanged.push(id)
    }
  }

  // 指标变化
  const metricDeltas: Record<string, number> = {
    testPassRate: summaryB.testPassRate - summaryA.testPassRate,
    avgTurnsPerTask: summaryB.avgTurnsPerTask - summaryA.avgTurnsPerTask,
    avgToolSuccessRate: summaryB.avgToolSuccessRate - summaryA.avgToolSuccessRate,
    avgEditSuccessRate: summaryB.avgEditSuccessRate - summaryA.avgEditSuccessRate,
    avgJudgeTaskCompletion: summaryB.avgJudgeTaskCompletion - summaryA.avgJudgeTaskCompletion,
    avgJudgeEfficiency: summaryB.avgJudgeEfficiency - summaryA.avgJudgeEfficiency,
  }

  // 生成摘要
  const parts: string[] = []
  if (improved.length > 0) parts.push(`${improved.length} tasks improved`)
  if (regressed.length > 0) parts.push(`${regressed.length} tasks regressed`)
  if (metricDeltas['testPassRate'] > 0.1) parts.push(`Overall pass rate improved by ${(metricDeltas['testPassRate'] * 100).toFixed(0)}%`)
  if (metricDeltas['testPassRate'] < -0.1) parts.push(`WARNING: Pass rate dropped by ${(Math.abs(metricDeltas['testPassRate']) * 100).toFixed(0)}%`)

  return {
    runA: summaryA.runName,
    runB: summaryB.runName,
    improved,
    regressed,
    unchanged,
    metricDeltas,
    summary: parts.length > 0 ? parts.join('. ') + '.' : 'No significant changes detected.',
  }
}

/**
 * 将工作区结果映射为可比较的分数（0-3）
 * 3 = test passed + judge >= 4
 * 2 = test passed or judge >= 3
 * 1 = test failed but agent tried (turns > 1)
 * 0 = crash or no attempt
 */
function taskScore(r: TaskEvalResult): number {
  if (r.error) return 0
  if (r.testPassed === true) {
    const judge = r.judgeScores['task_completion'] ?? 3
    return judge >= 4 ? 3 : 2
  }
  if (r.testPassed === false) return r.turnCount > 1 ? 1 : 0
  // 没有测试的工作区：用 judge 分
  const judge = r.judgeScores['task_completion'] ?? 0
  return judge >= 4 ? 3 : judge >= 3 ? 2 : judge >= 1 ? 1 : 0
}

function indexByTaskId(results: TaskEvalResult[]): Record<string, TaskEvalResult> {
  const map: Record<string, TaskEvalResult> = {}
  for (const r of results) {
    map[r.taskId] = r
  }
  return map
}
