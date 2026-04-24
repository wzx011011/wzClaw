// ============================================================
// 分层评估追踪器 — 按语言/类别/难度维度分别跟踪通过率退化
// 参考 Aider leaderboard 的分层报告 + METR 评估协议
// ============================================================

import type { RunSummary, TaskEvalResult } from './types'

/** 分层维度 */
export type StratumDimension = 'language' | 'difficulty' | 'category'

/** 单个分层的统计 */
export interface StratumStats {
  dimension: StratumDimension
  value: string
  total: number
  passed: number
  failed: number
  passRate: number
  avgTurns: number
  avgEfficiency: number
}

/** 分层对比结果 */
export interface StratumComparison {
  dimension: StratumDimension
  value: string
  oldPassRate: number
  newPassRate: number
  delta: number
  /** 是否退化超过阈值 */
  degraded: boolean
  oldTotal: number
  newTotal: number
}

/** 分层评估报告 */
export interface StratifiedReport {
  /** 各维度各层的统计 */
  strata: StratumStats[]
  /** 与上一次对比的变化（如果有） */
  comparisons: StratumComparison[]
  /** 检测到退化的分层 */
  degradedStrata: StratumComparison[]
  /** 整体是否有分层退化 */
  hasStratifiedDegradation: boolean
}

/**
 * 对一次 RunSummary 做分层统计
 */
export function computeStratifiedStats(summary: RunSummary): StratumStats[] {
  const stats: StratumStats[] = []

  // 按语言分组
  stats.push(...computeDimensionStats(summary.perTaskResults, 'language', r => r.language))
  // 按难度分组
  stats.push(...computeDimensionStats(summary.perTaskResults, 'difficulty', r => r.difficulty))
  // 按类别分组
  stats.push(...computeDimensionStats(summary.perTaskResults, 'category', r => r.taskSource))

  return stats
}

/**
 * 对比两次运行的分层统计，检测局部退化
 */
export function compareStratified(
  oldSummary: RunSummary,
  newSummary: RunSummary,
  degradationThreshold: number = 0.1,
): StratifiedReport {
  const oldStats = computeStratifiedStats(oldSummary)
  const newStats = computeStratifiedStats(newSummary)

  const comparisons: StratumComparison[] = []

  // 索引旧统计
  const oldIndex = new Map<string, StratumStats>()
  for (const s of oldStats) {
    oldIndex.set(`${s.dimension}:${s.value}`, s)
  }

  for (const newStat of newStats) {
    const key = `${newStat.dimension}:${newStat.value}`
    const oldStat = oldIndex.get(key)

    const oldRate = oldStat?.passRate ?? 0
    const delta = newStat.passRate - oldRate
    // 动态退化阈值：对小 stratum，只看绝对差；对大 stratum，看相对差
    const minDelta = newStat.total >= 5 ? degradationThreshold : 1 / newStat.total

    comparisons.push({
      dimension: newStat.dimension,
      value: newStat.value,
      oldPassRate: oldRate,
      newPassRate: newStat.passRate,
      delta,
      degraded: delta < -minDelta,
      oldTotal: oldStat?.total ?? 0,
      newTotal: newStat.total,
    })
  }

  const degradedStrata = comparisons.filter(c => c.degraded)

  return {
    strata: newStats,
    comparisons,
    degradedStrata,
    hasStratifiedDegradation: degradedStrata.length > 0,
  }
}

/**
 * 输出分层报告为 Markdown 格式
 */
export function formatStratifiedReport(report: StratifiedReport, datasetName: string): string {
  const lines: string[] = []
  lines.push(`### Stratified Analysis: ${datasetName}`)
  lines.push('')

  // 按维度分组输出当前统计
  const byDimension = new Map<StratumDimension, StratumStats[]>()
  for (const s of report.strata) {
    if (!byDimension.has(s.dimension)) byDimension.set(s.dimension, [])
    byDimension.get(s.dimension)!.push(s)
  }

  for (const [dim, stats] of byDimension) {
    lines.push(`#### By ${dim}`)
    lines.push('')
    lines.push('| Value | Total | Pass | Fail | Rate | Avg Turns |')
    lines.push('|-------|-------|------|------|------|-----------|')
    for (const s of stats.sort((a, b) => b.passRate - a.passRate)) {
      lines.push(`| ${s.value} | ${s.total} | ${s.passed} | ${s.failed} | ${(s.passRate * 100).toFixed(0)}% | ${s.avgTurns.toFixed(1)} |`)
    }
    lines.push('')
  }

  // 对比变化（如果有）
  if (report.comparisons.length > 0) {
    lines.push('#### Changes vs Previous')
    lines.push('')
    lines.push('| Dimension | Value | Before | After | Δ | Status |')
    lines.push('|-----------|-------|--------|-------|---|--------|')
    for (const c of report.comparisons.sort((a, b) => a.delta - b.delta)) {
      const status = c.degraded ? '🔴 DEGRADED' : c.delta > 0.05 ? '🟢 Improved' : '⚪ Stable'
      const deltaStr = c.delta >= 0 ? `+${(c.delta * 100).toFixed(0)}%` : `${(c.delta * 100).toFixed(0)}%`
      lines.push(`| ${c.dimension} | ${c.value} | ${(c.oldPassRate * 100).toFixed(0)}% | ${(c.newPassRate * 100).toFixed(0)}% | ${deltaStr} | ${status} |`)
    }
    lines.push('')
  }

  // 退化警告
  if (report.degradedStrata.length > 0) {
    lines.push('#### ⚠ Degradation Alerts')
    lines.push('')
    for (const d of report.degradedStrata) {
      lines.push(`- **${d.dimension}=${d.value}**: ${(d.oldPassRate * 100).toFixed(0)}% → ${(d.newPassRate * 100).toFixed(0)}% (${(d.delta * 100).toFixed(0)}%, n=${d.newTotal})`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ---- Internal ----

function computeDimensionStats(
  results: TaskEvalResult[],
  dimension: StratumDimension,
  keyFn: (r: TaskEvalResult) => string,
): StratumStats[] {
  const groups = new Map<string, TaskEvalResult[]>()
  for (const r of results) {
    const key = keyFn(r)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(r)
  }

  const stats: StratumStats[] = []
  for (const [value, tasks] of groups) {
    const tested = tasks.filter(t => t.testPassed !== null)
    const passed = tested.filter(t => t.testPassed === true).length
    const failed = tested.filter(t => t.testPassed === false).length
    const total = tested.length || 1

    stats.push({
      dimension,
      value,
      total: tested.length,
      passed,
      failed,
      passRate: passed / total,
      avgTurns: tasks.reduce((s, t) => s + t.turnCount, 0) / tasks.length,
      avgEfficiency: tasks.reduce((s, t) => s + (t.judgeScores['efficiency'] ?? 3), 0) / tasks.length,
    })
  }

  return stats
}
