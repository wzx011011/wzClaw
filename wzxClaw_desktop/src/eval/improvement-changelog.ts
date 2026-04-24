// ============================================================
// 改进变更日志 — 每次基线更新时生成完整 Markdown 报告
// 记录 prompt diff、代码变更、任务级别改进/回退、统计噪声估计
// ============================================================

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { compareRuns } from './comparison-report'
import type { RunSummary, WeaknessReport, IterationState } from './types'

const CHANGELOG_DIR = '.eval-reports/changelogs'

export interface ChangelogEntry {
  iteration: number
  timestamp: string
  /** 旧基线 pass rate → 新基线 pass rate */
  oldPassRates: Record<string, number>
  newPassRates: Record<string, number>
  /** prompt 变更列表 */
  promptChanges: string[]
  /** 代码变更列表 */
  codeChanges: string[]
  /** prompt diff (旧 → 新) */
  promptDiff: string
  /** 按数据集的对比报告 */
  datasetComparisons: Record<string, {
    improved: string[]
    regressed: string[]
    unchanged: string[]
    metricDeltas: Record<string, number>
  }>
  /** 弱点分析摘要 */
  weaknessSummary: string[]
  /** 噪声估计（基于样本量） */
  noiseEstimate: Record<string, { sampleSize: number; singleFlipDelta: number }>
}

/**
 * 生成改进变更日志 Markdown 并写入文件
 */
export function writeImprovementChangelog(opts: {
  iteration: number
  oldPassRates: Record<string, number>
  newPassRates: Record<string, number>
  oldPrompt: string
  newPrompt: string
  promptChanges: string[]
  codeChanges: string[]
  oldTrainResults: Record<string, RunSummary>
  newTrainResults: Record<string, RunSummary>
  weaknessReport: WeaknessReport
  state: IterationState
}): string {
  const {
    iteration, oldPassRates, newPassRates,
    oldPrompt, newPrompt, promptChanges, codeChanges,
    oldTrainResults, newTrainResults, weaknessReport, state,
  } = opts

  const ts = new Date().toISOString()

  // ---- 构建 Markdown ----
  const lines: string[] = []

  lines.push(`# Improvement Changelog — Iteration ${iteration + 1}`)
  lines.push('')
  lines.push(`**Timestamp**: ${ts}`)
  lines.push(`**Stagnation resets**: ${state.stagnationCount} consecutive non-improving prior to this`)
  lines.push('')

  // 1. 通过率变化总览
  lines.push('## Pass Rate Changes')
  lines.push('')
  lines.push('| Dataset | Before | After | Delta | Target |')
  lines.push('|---------|--------|-------|-------|--------|')
  for (const ds of Object.keys(newPassRates)) {
    const old = ((oldPassRates[ds] ?? 0) * 100).toFixed(1)
    const now = ((newPassRates[ds] ?? 0) * 100).toFixed(1)
    const delta = ((newPassRates[ds] ?? 0) - (oldPassRates[ds] ?? 0)) * 100
    const deltaStr = delta >= 0 ? `+${delta.toFixed(1)}%` : `${delta.toFixed(1)}%`
    const target = '—' // 调用方不传 target，从 state.history 无法得知
    lines.push(`| ${ds} | ${old}% | ${now}% | ${deltaStr} | ${target} |`)
  }
  lines.push('')

  // 2. 噪声估计
  lines.push('## Statistical Noise Estimate')
  lines.push('')
  lines.push('> Single-task flip impact quantifies the minimum pass-rate change caused by one task changing result.')
  lines.push('> Improvements smaller than this are unreliable.')
  lines.push('')
  lines.push('| Dataset | Train Size | 1-flip Δ | Improvement | Reliable? |')
  lines.push('|---------|-----------|----------|-------------|-----------|')
  for (const [ds, summary] of Object.entries(newTrainResults)) {
    const n = summary.totalTasks
    const flipDelta = (1 / n * 100).toFixed(1)
    const improvement = Math.abs(((newPassRates[ds] ?? 0) - (oldPassRates[ds] ?? 0)) * 100)
    const reliable = improvement > (1 / n * 100) ? '✓ Yes' : '⚠ Marginal'
    lines.push(`| ${ds} | ${n} | ±${flipDelta}% | ${improvement.toFixed(1)}% | ${reliable} |`)
  }
  lines.push('')

  // 3. 任务级别变更
  lines.push('## Task-Level Changes')
  lines.push('')
  for (const [ds, newSummary] of Object.entries(newTrainResults)) {
    const oldSummary = oldTrainResults[ds]
    if (!oldSummary) continue

    const comparison = compareRuns(oldSummary, newSummary)
    lines.push(`### ${ds}`)
    lines.push('')
    lines.push(`${comparison.summary}`)
    lines.push('')

    if (comparison.improved.length > 0) {
      lines.push('**Improved tasks:**')
      for (const taskId of comparison.improved) {
        const oldTask = oldSummary.perTaskResults.find(r => r.taskId === taskId)
        const newTask = newSummary.perTaskResults.find(r => r.taskId === taskId)
        const oldStatus = oldTask?.testPassed === true ? 'PASS' : oldTask?.testPassed === false ? 'FAIL' : 'N/A'
        const newStatus = newTask?.testPassed === true ? 'PASS' : newTask?.testPassed === false ? 'FAIL' : 'N/A'
        const lang = newTask?.language ?? oldTask?.language ?? '?'
        const diff = newTask?.difficulty ?? oldTask?.difficulty ?? '?'
        lines.push(`- \`${taskId}\` (${lang}/${diff}): ${oldStatus} → ${newStatus}`)
      }
      lines.push('')
    }

    if (comparison.regressed.length > 0) {
      lines.push('**Regressed tasks:**')
      for (const taskId of comparison.regressed) {
        const oldTask = oldSummary.perTaskResults.find(r => r.taskId === taskId)
        const newTask = newSummary.perTaskResults.find(r => r.taskId === taskId)
        const oldStatus = oldTask?.testPassed === true ? 'PASS' : oldTask?.testPassed === false ? 'FAIL' : 'N/A'
        const newStatus = newTask?.testPassed === true ? 'PASS' : newTask?.testPassed === false ? 'FAIL' : 'N/A'
        const lang = newTask?.language ?? oldTask?.language ?? '?'
        const diff = newTask?.difficulty ?? oldTask?.difficulty ?? '?'
        lines.push(`- \`${taskId}\` (${lang}/${diff}): ${oldStatus} → ${newStatus}`)
      }
      lines.push('')
    }

    // 指标 delta 表
    lines.push('**Metric deltas:**')
    lines.push('')
    lines.push('| Metric | Delta |')
    lines.push('|--------|-------|')
    for (const [metric, delta] of Object.entries(comparison.metricDeltas)) {
      const sign = delta >= 0 ? '+' : ''
      lines.push(`| ${metric} | ${sign}${delta.toFixed(3)} |`)
    }
    lines.push('')
  }

  // 4. Prompt 变更
  lines.push('## Prompt Changes')
  lines.push('')
  if (promptChanges.length === 0) {
    lines.push('No prompt changes in this iteration.')
  } else {
    lines.push(`Applied ${promptChanges.length} rule(s):`)
    for (const c of promptChanges) {
      lines.push(`- ${c}`)
    }
  }
  lines.push('')

  // Prompt diff
  lines.push('### Prompt Diff')
  lines.push('')
  const diff = computeSimpleDiff(oldPrompt, newPrompt)
  if (diff) {
    lines.push('```diff')
    lines.push(diff)
    lines.push('```')
  } else {
    lines.push('No diff (prompt unchanged).')
  }
  lines.push('')

  // 5. 代码变更
  lines.push('## Code Changes')
  lines.push('')
  if (codeChanges.length === 0) {
    lines.push('No code optimizations applied.')
  } else {
    for (const c of codeChanges) {
      lines.push(`- ${c}`)
    }
  }
  lines.push('')

  // 6. 弱点摘要
  lines.push('## Weakness Report Summary')
  lines.push('')
  if (weaknessReport.topRecommendations.length === 0) {
    lines.push('No weakness patterns detected.')
  } else {
    for (const r of weaknessReport.topRecommendations) {
      lines.push(`- ${r}`)
    }
  }
  lines.push('')

  // 7. 累计历史
  lines.push('## Cumulative History')
  lines.push('')
  lines.push('| Iteration | Improved | Best Pass Rate (avg) |')
  lines.push('|-----------|----------|---------------------|')
  for (const record of state.history) {
    const avg = Object.values(record.currentPassRate)
    const avgRate = avg.length > 0 ? avg.reduce((a, b) => a + b, 0) / avg.length : 0
    lines.push(`| ${record.iteration} | ${record.improved ? '✓' : '✗'} | ${(avgRate * 100).toFixed(1)}% |`)
  }
  // 当前迭代（尚未 push 到 history）
  const currentAvg = Object.values(newPassRates)
  const currentAvgRate = currentAvg.length > 0 ? currentAvg.reduce((a, b) => a + b, 0) / currentAvg.length : 0
  lines.push(`| ${iteration + 1} | ✓ | ${(currentAvgRate * 100).toFixed(1)}% |`)
  lines.push('')

  // ---- 写文件 ----
  const md = lines.join('\n')
  const dir = resolve(CHANGELOG_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const filePath = resolve(dir, `iteration-${String(iteration + 1).padStart(3, '0')}.md`)
  writeFileSync(filePath, md, 'utf-8')

  console.log(`  📝 Changelog written: ${filePath}`)
  return filePath
}

/**
 * 简单行级 diff：对比两个字符串，输出 +/- 标记
 */
function computeSimpleDiff(oldText: string, newText: string): string {
  if (oldText === newText) return ''

  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const output: string[] = []

  // 找到共同前缀
  let commonPrefix = 0
  while (commonPrefix < oldLines.length && commonPrefix < newLines.length
    && oldLines[commonPrefix] === newLines[commonPrefix]) {
    commonPrefix++
  }

  // 找到共同后缀
  let commonSuffix = 0
  while (commonSuffix < oldLines.length - commonPrefix
    && commonSuffix < newLines.length - commonPrefix
    && oldLines[oldLines.length - 1 - commonSuffix] === newLines[newLines.length - 1 - commonSuffix]) {
    commonSuffix++
  }

  // 变更区域
  const oldEnd = oldLines.length - commonSuffix
  const newEnd = newLines.length - commonSuffix

  if (commonPrefix > 0) {
    output.push(`@@ -${commonPrefix + 1},${oldEnd - commonPrefix} +${commonPrefix + 1},${newEnd - commonPrefix} @@`)
  }

  // 上下文（最多 3 行）
  const ctxStart = Math.max(0, commonPrefix - 3)
  for (let i = ctxStart; i < commonPrefix; i++) {
    output.push(` ${oldLines[i]}`)
  }

  for (let i = commonPrefix; i < oldEnd; i++) {
    output.push(`-${oldLines[i]}`)
  }
  for (let i = commonPrefix; i < newEnd; i++) {
    output.push(`+${newLines[i]}`)
  }

  // 下文（最多 3 行）
  const ctxEnd = Math.min(oldLines.length, oldEnd + 3)
  for (let i = oldEnd; i < ctxEnd; i++) {
    output.push(` ${oldLines[i]}`)
  }

  return output.join('\n')
}
