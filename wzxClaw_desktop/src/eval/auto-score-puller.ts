// ============================================================
// Layer B 自动评分拉取器 — 从 Langfuse trace 拉取 EvalCollector 采集的指标
// ============================================================

import type { Langfuse } from 'langfuse'

/** EvalCollector 推送的 8 个自动评分名称 */
const AUTO_SCORE_NAMES = new Set([
  'tool_success_rate',
  'tool_diversity',
  'edit_success_rate',
  'context_pressure',
  'compaction_count',
  'error_recovery',
  'loop_detected',
  'avg_output_per_turn',
])

/**
 * 从 Langfuse 拉取指定 trace 的 Layer B 自动评分
 *
 * 重试机制：Langfuse flush 是异步的，需要等待写入完成
 *
 * @param lf Langfuse 客户端实例
 * @param traceId trace ID（即 conversationId，需在 langfuse-observer 中通过 id 参数传入）
 * @param maxRetries 最大重试次数
 */
export async function pullAutoScores(
  lf: Langfuse,
  traceId: string,
  maxRetries = 3,
): Promise<Record<string, number | string>> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await lf.api.traceGet(traceId)
      const scores = (resp as any)?.data?.scores ?? (resp as any)?.scores ?? []

      const filtered = (scores as Array<{ name: string; value: number | string }>)
        .filter(s => AUTO_SCORE_NAMES.has(s.name))

      if (filtered.length > 0) {
        const result: Record<string, number | string> = {}
        for (const s of filtered) {
          result[s.name] = s.value
        }
        return result
      }
    } catch {
      // traceGet 可能因为 flush 未完成而暂时取不到，重试
    }

    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)))
    }
  }

  return {}
}
