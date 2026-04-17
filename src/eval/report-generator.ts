// ============================================================
// 报告生成器 — 将 RunSummary 和 WeaknessReport 转为 Markdown
// ============================================================

import { mkdir, writeFile } from 'fs/promises'
import { resolve, join } from 'path'
import type { RunSummary, WeaknessReport, ComparisonReport, TaskEvalResult } from './types'

const REPORTS_DIR = '.eval-reports'

/**
 * 生成摘要报告（每个任务一行）
 */
export function generateSummaryReport(summary: RunSummary): string {
  const lines: string[] = []
  lines.push(`# Eval Report: ${summary.runName}`)
  lines.push(``)
  lines.push(`- **Date**: ${summary.timestamp}`)
  lines.push(`- **Dataset**: ${summary.datasetName}`)
  lines.push(`- **Model**: ${summary.model}`)
  lines.push(`- **Tasks**: ${summary.totalTasks}`)
  lines.push(``)

  // 整体指标
  lines.push(`## Overall Metrics`)
  lines.push(``)
  lines.push(`| Metric | Value |`)
  lines.push(`|--------|-------|`)
  lines.push(`| Test Pass Rate | **${(summary.testPassRate * 100).toFixed(0)}%** |`)
  lines.push(`| Avg Turns/Task | ${summary.avgTurnsPerTask.toFixed(1)} |`)
  lines.push(`| Avg Tool Success Rate | ${(summary.avgToolSuccessRate * 100).toFixed(0)}% |`)
  lines.push(`| Avg Edit Success Rate | ${(summary.avgEditSuccessRate * 100).toFixed(0)}% |`)
  lines.push(`| Avg Judge: Task Completion | ${summary.avgJudgeTaskCompletion.toFixed(1)}/5 |`)
  lines.push(`| Avg Judge: Efficiency | ${summary.avgJudgeEfficiency.toFixed(1)}/5 |`)
  lines.push(``)

  // 每个任务详情
  lines.push(`## Task Results`)
  lines.push(``)
  lines.push(`| Task | Lang | Diff | Test | Turns | Duration | Judge |`)
  lines.push(`|------|------|------|------|-------|----------|-------|`)

  for (const r of summary.perTaskResults) {
    const test = r.testPassed === true ? ':white_check_mark:' : r.testPassed === false ? ':x:' : '-'
    const judge = r.judgeScores['task_completion'] ?? '-'
    const dur = (r.duration / 1000).toFixed(1)
    const err = r.error ? ` **ERROR**` : ''
    const traceLink = r.traceId ? `[trace](${process.env.LANGFUSE_BASE_URL ?? 'http://192.168.100.78:3000'}/trace/${r.traceId})` : ''
    lines.push(`| ${r.taskId}${err} | ${r.language} | ${r.difficulty} | ${test} | ${r.turnCount} | ${dur}s | ${judge}/5 ${traceLink} |`)
  }
  lines.push(``)

  return lines.join('\n')
}

/**
 * 生成弱点报告
 */
export function generateWeaknessReport(report: WeaknessReport): string {
  const lines: string[] = []
  lines.push(`# Weakness Analysis: ${report.runName}`)
  lines.push(``)
  lines.push(`**Date**: ${report.timestamp}`)
  lines.push(``)

  lines.push(`## Top Recommendations`)
  lines.push(``)
  for (const rec of report.topRecommendations) {
    lines.push(`- ${rec}`)
  }
  lines.push(``)

  lines.push(`## Detailed Findings`)
  lines.push(``)
  for (const cat of report.categories.sort((a, b) => severityOrder(b.severity) - severityOrder(a.severity))) {
    lines.push(`### ${cat.name} (${cat.severity})`)
    lines.push(``)
    lines.push(`**Evidence**: ${cat.evidence}`)
    lines.push(``)
    lines.push(`**Affected tasks**: ${cat.affectedTasks.join(', ') || 'none'}`)
    lines.push(``)
    lines.push(`**Fix**: ${cat.recommendation}`)
    lines.push(``)
  }

  return lines.join('\n')
}

/**
 * 生成对比报告
 */
export function generateComparisonReport(report: ComparisonReport, summaryA: RunSummary, summaryB: RunSummary): string {
  const lines: string[] = []
  lines.push(`# Comparison: ${report.runA} vs ${report.runB}`)
  lines.push(``)
  lines.push(`## Summary`)
  lines.push(``)
  lines.push(`| Metric | ${report.runA} | ${report.runB} | Delta |`)
  lines.push(`|--------|---------|---------|-------|`)
  lines.push(`| Test Pass Rate | ${(summaryA.testPassRate * 100).toFixed(0)}% | ${(summaryB.testPassRate * 100).toFixed(0)}% | ${formatDelta(report.metricDeltas['testPassRate'] ?? 0, '%')} |`)
  lines.push(`| Avg Turns | ${summaryA.avgTurnsPerTask.toFixed(1)} | ${summaryB.avgTurnsPerTask.toFixed(1)} | ${formatDelta(report.metricDeltas['avgTurnsPerTask'] ?? 0, '')} |`)
  lines.push(`| Judge Task Completion | ${summaryA.avgJudgeTaskCompletion.toFixed(1)}/5 | ${summaryB.avgJudgeTaskCompletion.toFixed(1)}/5 | ${formatDelta(report.metricDeltas['avgJudgeTaskCompletion'] ?? 0, '')} |`)
  lines.push(``)
  lines.push(`**Improved**: ${report.improved.length} tasks`)
  lines.push(`**Regressed**: ${report.regressed.length} tasks`)
  lines.push(`**Unchanged**: ${report.unchanged.length} tasks`)
  lines.push(``)
  lines.push(report.summary)
  lines.push(``)

  return lines.join('\n')
}

/**
 * 保存报告到文件
 */
export async function saveReport(content: string, filename: string): Promise<string> {
  const dir = resolve(REPORTS_DIR)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, filename)
  await writeFile(filePath, content, 'utf-8')
  return filePath
}

function formatDelta(value: number, suffix: string): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(0)}${suffix}`
}

function severityOrder(s: string): number {
  return s === 'critical' ? 3 : s === 'warning' ? 2 : 1
}
