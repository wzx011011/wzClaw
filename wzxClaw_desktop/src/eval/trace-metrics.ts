// ============================================================
// Trace 指标 — 跨工作区聚合诊断指标，回答"为什么失败"
// ============================================================

import type { TaskEvalResult, TraceMetrics } from './types'

/**
 * 从一批工作区结果中计算诊断指标
 * 结果中必须包含 traceData（通过 storeTraceData=true 收集）
 */
export function computeTraceMetrics(results: TaskEvalResult[]): TraceMetrics {
  // 分组：有 traceData 的失败工作区 vs 成功工作区
  const withTrace = results.filter(r => r.traceData)
  const failed = withTrace.filter(r => r.testPassed === false)
  const succeeded = withTrace.filter(r => r.testPassed === true)

  const failedCount = failed.length || 1 // avoid /0
  const succeededCount = succeeded.length || 1

  // 没跑测试就结束的失败工作区比例
  const noTestRun = failed.filter(r => !r.traceData!.ranTestBeforeDone).length
  const noTestRunRate = noTestRun / failedCount

  // 第一次编辑就失败的
  const firstEditFail = failed.filter(r =>
    r.traceData!.firstEditAttempt?.isError === true
  ).length
  const firstEditFailRate = firstEditFail / failedCount

  // 触达最大轮次的
  const maxTurns = failed.filter(r => r.traceData!.hitMaxTurns).length
  const maxTurnsRate = maxTurns / failedCount

  // 盲目编辑（没读就改）
  const blindEdit = failed.filter(r =>
    r.traceData!.readsBeforeFirstEdit === 0 && r.traceData!.firstEditAttempt
  ).length
  const blindEditRate = blindEdit / failedCount

  // 平均编辑前读取次数（成功 vs 失败）
  const avgReadsSuccess = succeededCount > 0
    ? succeeded.reduce((s, r) => s + r.traceData!.readsBeforeFirstEdit, 0) / succeededCount
    : 0
  const avgReadsFailure = failedCount > 0
    ? failed.reduce((s, r) => s + r.traceData!.readsBeforeFirstEdit, 0) / failedCount
    : 0

  // 工具错误恢复率：有工具错误但最终通过的比例
  const withErrors = withTrace.filter(r => r.traceData!.errorCount > 0)
  const recovered = withErrors.filter(r => r.testPassed === true).length
  const toolErrorRecoveryRate = withErrors.length > 0 ? recovered / withErrors.length : 1

  return {
    noTestRunRate,
    firstEditFailRate,
    maxTurnsRate,
    blindEditRate,
    avgReadsBeforeEditSuccess: avgReadsSuccess,
    avgReadsBeforeEditFailure: avgReadsFailure,
    toolErrorRecoveryRate,
  }
}

/**
 * 格式化指标为可读字符串
 */
export function formatTraceMetrics(metrics: TraceMetrics): string {
  const lines: string[] = [
    `  No-test-run rate:   ${(metrics.noTestRunRate * 100).toFixed(0)}%`,
    `  First-edit fail:    ${(metrics.firstEditFailRate * 100).toFixed(0)}%`,
    `  Max-turns hit:      ${(metrics.maxTurnsRate * 100).toFixed(0)}%`,
    `  Blind-edit rate:    ${(metrics.blindEditRate * 100).toFixed(0)}%`,
    `  Reads before edit:  ${metrics.avgReadsBeforeEditSuccess.toFixed(1)} (pass) vs ${metrics.avgReadsBeforeEditFailure.toFixed(1)} (fail)`,
    `  Error recovery:     ${(metrics.toolErrorRecoveryRate * 100).toFixed(0)}%`,
  ]
  return lines.join('\n')
}
