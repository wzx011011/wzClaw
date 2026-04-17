// ============================================================
// 弱点分析器 — 从评测结果中检测失败模式，给出可操作修复建议
// ============================================================

import type { RunSummary, TaskEvalResult, WeaknessReport, WeaknessCategory } from './types'

/**
 * 分析一次 run 的结果，检测系统性弱点
 */
export function analyzeWeaknesses(summary: RunSummary): WeaknessReport {
  const categories: WeaknessCategory[] = []
  const results = summary.perTaskResults

  // ---- 规则 1: 测试失败率高 ----
  const testedTasks = results.filter(r => r.testPassed !== null)
  if (testedTasks.length > 0) {
    const failRate = testedTasks.filter(r => r.testPassed === false).length / testedTasks.length
    if (failRate > 0.5) {
      categories.push({
        name: 'test_failure_high',
        severity: 'critical',
        affectedTasks: testedTasks.filter(r => r.testPassed === false).map(r => r.taskId),
        evidence: `Test failure rate: ${(failRate * 100).toFixed(0)}% (${testedTasks.filter(r => r.testPassed === false).length}/${testedTasks.length})`,
        recommendation: 'Agent writes code but tests fail. Consider adding test-driven guidance to system prompt: "After writing code, run the test command to verify."',
      })
    } else if (failRate > 0.3) {
      categories.push({
        name: 'test_failure_moderate',
        severity: 'warning',
        affectedTasks: testedTasks.filter(r => r.testPassed === false).map(r => r.taskId),
        evidence: `Test failure rate: ${(failRate * 100).toFixed(0)}%`,
        recommendation: 'Some tests fail. Review failed tasks for patterns — check if agent handles edge cases correctly.',
      })
    }
  }

  // ---- 规则 2: 平均 turns 过高 ----
  if (summary.avgTurnsPerTask > 10) {
    categories.push({
      name: 'high_turn_count',
      severity: 'warning',
      affectedTasks: results.filter(r => r.turnCount > 10).map(r => r.taskId),
      evidence: `Average turns per task: ${summary.avgTurnsPerTask.toFixed(1)}`,
      recommendation: 'Agent takes too many turns for simple tasks. Optimize system prompt to encourage direct solutions. Consider adding "Think first, then act in one step" guidance.',
    })
  }

  // ---- 规则 3: 按难度分析 ----
  const easyTasks = results.filter(r => r.difficulty === 'easy')
  const easyFailRate = easyTasks.filter(r => r.testPassed === false).length / Math.max(easyTasks.length, 1)
  if (easyFailRate > 0.3) {
    categories.push({
      name: 'easy_tasks_failing',
      severity: 'critical',
      affectedTasks: easyTasks.filter(r => r.testPassed === false).map(r => r.taskId),
      evidence: `Easy task failure rate: ${(easyFailRate * 100).toFixed(0)}%`,
      recommendation: 'Agent fails basic tasks. Check if tool execution (FileWrite, FileEdit) works correctly. Verify system prompt provides clear coding instructions.',
    })
  }

  // ---- 规则 4: 按语言分析 ----
  const byLang = groupBy(results, 'language')
  for (const [lang, tasks] of Object.entries(byLang)) {
    const langFailRate = tasks.filter(r => r.testPassed === false).length / Math.max(tasks.filter(r => r.testPassed !== null).length, 1)
    if (langFailRate > 0.5 && tasks.length >= 2) {
      categories.push({
        name: `weak_language_${lang}`,
        severity: 'warning',
        affectedTasks: tasks.filter(r => r.testPassed === false).map(r => r.taskId),
        evidence: `${lang} failure rate: ${(langFailRate * 100).toFixed(0)}% (${tasks.length} tasks)`,
        recommendation: `Agent performs poorly on ${lang} tasks. Consider adding language-specific guidance to system prompt or testing ${lang} tool execution.`,
      })
    }
  }

  // ---- 规则 5: 按类别分析 ----
  const byCategory = groupBy(results.map(r => ({ ...r, category: r.taskSource })), 'category')
  for (const [cat, tasks] of Object.entries(byCategory)) {
    const catFailRate = tasks.filter(r => r.testPassed === false).length / Math.max(tasks.filter(r => r.testPassed !== null).length, 1)
    if (catFailRate > 0.5 && tasks.length >= 2) {
      categories.push({
        name: `weak_category_${cat}`,
        severity: 'info',
        affectedTasks: tasks.filter(r => r.testPassed === false).map(r => r.taskId),
        evidence: `${cat} category failure rate: ${(catFailRate * 100).toFixed(0)}%`,
        recommendation: `Agent struggles with ${cat} tasks. Review specific failures and add targeted guidance.`,
      })
    }
  }

  // ---- 规则 6: 错误任务 ----
  const errorTasks = results.filter(r => r.error)
  if (errorTasks.length > 0) {
    categories.push({
      name: 'runtime_errors',
      severity: 'critical',
      affectedTasks: errorTasks.map(r => r.taskId),
      evidence: `${errorTasks.length} tasks crashed with errors: ${errorTasks.map(r => r.error?.slice(0, 100)).join('; ')}`,
      recommendation: 'Agent execution crashed. Check headless-runner logs for the specific errors. Likely causes: API rate limits, tool execution failures, or context window overflow.',
    })
  }

  // ---- 规则 7: Judge 效率评分低 ----
  const lowEfficiency = results.filter(r => (r.judgeScores['efficiency'] ?? 5) < 3)
  if (lowEfficiency.length > results.length * 0.3) {
    categories.push({
      name: 'low_efficiency',
      severity: 'info',
      affectedTasks: lowEfficiency.map(r => r.taskId),
      evidence: `${lowEfficiency.length}/${results.length} tasks scored <3/5 on efficiency`,
      recommendation: 'Agent wastes turns on unnecessary tool calls. Add prompt guidance to read files first, plan edits, then execute in minimal steps.',
    })
  }

  // 生成 top 建议
  const topRecommendations = categories
    .sort((a, b) => severityOrder(b.severity) - severityOrder(a.severity))
    .slice(0, 5)
    .map(c => `[${c.severity.toUpperCase()}] ${c.name}: ${c.recommendation}`)

  return {
    runName: summary.runName,
    timestamp: new Date().toISOString(),
    categories,
    topRecommendations,
  }
}

function groupBy<T extends Record<string, any>>(arr: T[], key: string): Record<string, T[]> {
  const map: Record<string, T[]> = {}
  for (const item of arr) {
    const k = String(item[key] ?? 'unknown')
    if (!map[k]) map[k] = []
    map[k].push(item)
  }
  return map
}

function severityOrder(s: string): number {
  return s === 'critical' ? 3 : s === 'warning' ? 2 : 1
}
