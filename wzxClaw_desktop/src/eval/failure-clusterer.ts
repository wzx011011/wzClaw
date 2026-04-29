// ============================================================
// 失败聚类器 — 按根因分组失败工作区，输出优先级排序的修复列表
// ============================================================

import type { FailureClassification, FailureCluster, TaskEvalResult } from './types'

/**
 * 将失败分类按 taxonomy → failureMode 二级分组
 * 每个 cluster 计算 impact = count * (1 + hardTaskRatio)
 * 按 impact 降序排列
 */
export function clusterFailures(
  classifications: FailureClassification[],
  results: TaskEvalResult[],
): FailureCluster[] {
  const difficultyMap = new Map<string, string>()
  for (const r of results) {
    difficultyMap.set(r.taskId, r.difficulty)
  }

  // 按 taxonomy + failureMode 分组
  const groups = new Map<string, FailureClassification[]>()
  for (const cls of classifications) {
    const key = `${cls.taxonomy}::${cls.failureMode}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(cls)
  }

  const clusters: FailureCluster[] = []
  let priority = 0

  for (const [key, items] of groups) {
    const [taxonomy, failureMode] = key.split('::')

    // 计算硬工作区比例
    const hardCount = items.filter(cls => {
      const diff = difficultyMap.get(cls.taskId)
      return diff === 'hard' || diff === 'medium'
    }).length
    const hardRatio = hardCount / Math.max(items.length, 1)

    const impact = items.length * (1 + hardRatio)

    // 收集去重的 suggestedPromptFix
    const fixes = [...new Set(items.map(i => i.suggestedPromptFix).filter(Boolean))]

    // 取最常见的 rootCause 作为代表
    const causeCounts = new Map<string, number>()
    for (const item of items) {
      causeCounts.set(item.rootCause, (causeCounts.get(item.rootCause) ?? 0) + 1)
    }
    const representativeCause = [...causeCounts.entries()]
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''

    clusters.push({
      failureMode,
      taxonomy,
      taskIds: items.map(i => i.taskId),
      count: items.length,
      impact: parseFloat(impact.toFixed(2)),
      representativeCause,
      suggestedFixes: fixes,
      priority: 0, // assigned after sorting
    })
  }

  // 按 impact 降序排列，赋予优先级
  clusters.sort((a, b) => b.impact - a.impact)
  clusters.forEach((c, i) => { c.priority = i + 1 })

  return clusters
}

/**
 * 格式化聚类摘要
 */
export function formatClusterSummary(clusters: FailureCluster[]): string {
  if (clusters.length === 0) return '  No failure clusters detected.'

  return clusters.slice(0, 5).map(c =>
    `  #${c.priority} [${c.taxonomy}/${c.failureMode}] impact=${c.impact} (${c.count} tasks)\n` +
    `     Cause: ${c.representativeCause}\n` +
    `     Tasks: ${c.taskIds.slice(0, 5).join(', ')}${c.taskIds.length > 5 ? ` +${c.taskIds.length - 5}` : ''}`
  ).join('\n')
}
