// ============================================================
// OPRO 优化器 — LLM-in-the-loop prompt 优化，基于失败聚类
// 替代 prompt-optimizer.ts 的静态模板映射
// 输入：具体失败 cluster（含 rootCause + affectedTaskIds）
// 优势：接收完整优化历史，避免重复失败的修改
// ============================================================

import type { FailureCluster, OptimizationHistoryEntry } from './types'

/** OPRO 优化结果 */
export interface OPROResult {
  prompt: string
  changes: string[]
  rationale: string
}

/**
 * 基于 OPRO 模式生成 prompt 修改
 *
 * 与静态模板的区别：
 * 1. 输入是具体失败 cluster（含 rootCause + affectedTaskIds）
 * 2. 接收完整优化历史，LLM 知道哪些修改有效、哪些被回滚
 * 3. LLM 生成针对性修复，而非套用预设文本
 */
export async function generatePromptWithOPRO(
  currentPrompt: string,
  clusters: FailureCluster[],
  history: OptimizationHistoryEntry[],
  config: { apiKey: string; baseURL: string; model: string },
): Promise<OPROResult> {
  if (clusters.length === 0) {
    return { prompt: currentPrompt, changes: [], rationale: 'No failure clusters to optimize.' }
  }

  // 构建优化历史摘要
  const historySummary = history.length > 0
    ? history.slice(-5).map(h =>
        `  Iter ${h.iteration}: targeted [${h.targetedClusters.join(', ')}] → ` +
        `${h.kept ? 'KEPT' : 'ROLLED BACK'} (pass rate: ${formatPassRate(h.resultPassRate)})`
      ).join('\n')
    : '  (first optimization)'

  // 构建失败聚类描述（取 top 3）
  const clusterDesc = clusters.slice(0, 3).map(c =>
    `[${c.taxonomy}/${c.failureMode}] impact=${c.impact}, ${c.count} tasks\n` +
    `  Root cause: ${c.representativeCause}\n` +
    `  Affected: ${c.taskIds.slice(0, 5).join(', ')}\n` +
    `  Suggested direction: ${c.suggestedFixes[0] ?? 'none'}`
  ).join('\n\n')

  const prompt = `You are optimizing the system prompt of a coding agent. The agent failed some benchmark tasks.

CURRENT SYSTEM PROMPT (first 1000 chars):
"""
${currentPrompt.slice(0, 1000)}${currentPrompt.length > 1000 ? '...' : ''}
"""

FAILURE ANALYSIS (top clusters by impact):
${clusterDesc}

OPTIMIZATION HISTORY (recent attempts):
${historySummary}

Based on the specific failure patterns above, generate a targeted prompt addition.

Rules:
- Focus on the TOP cluster (highest impact)
- Be specific: reference the actual failure mode, not generic advice
- Maximum 3 sentences
- Do NOT repeat advice already in the current prompt
- Do NOT repeat modifications that were previously ROLLED BACK
- Use imperative style ("When X, do Y")

Respond with JSON only:
{
  "targetCluster": "failure_mode_name",
  "addition": "the prompt text to append",
  "rationale": "why this will fix the failures",
  "expectedImpact": "which tasks this should improve"
}`

  try {
    const result = await callOproLlm(prompt, config)
    const parsed = extractJson(result)
    if (parsed && parsed.addition && typeof parsed.addition === 'string') {
      const addition = String(parsed.addition).trim()
      if (addition.length < 10 || addition.length > 500) {
        return { prompt: currentPrompt, changes: [], rationale: 'LLM addition out of size bounds' }
      }

      // 避免重复：检查当前 prompt 是否已包含类似内容
      const additionSlug = addition.slice(0, 50).toLowerCase()
      if (currentPrompt.toLowerCase().includes(additionSlug)) {
        return { prompt: currentPrompt, changes: [], rationale: 'Similar guidance already in prompt' }
      }

      const marker = `\n/* EVAL-OPRO: ${parsed.targetCluster ?? 'unknown'} */`
      const newPrompt = currentPrompt + '\n\n# Eval-Optimized Guidance\n' + marker + '\n' + addition + '\n'

      return {
        prompt: newPrompt,
        changes: [`OPRO: ${parsed.targetCluster ?? 'unknown'} — ${String(parsed.rationale ?? '').slice(0, 100)}`],
        rationale: String(parsed.rationale ?? ''),
      }
    }
  } catch { /* fall through */ }

  return { prompt: currentPrompt, changes: [], rationale: 'OPRO optimization failed' }
}

async function callOproLlm(
  prompt: string,
  config: { apiKey: string; baseURL: string; model: string },
): Promise<string | null> {
  const url = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: 'You are a prompt optimization expert for coding agents. Respond only with valid JSON.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 500,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!resp.ok) return null
  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content ?? null
}

function extractJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    try { return JSON.parse(codeBlockMatch[1].trim()) } catch { /* fall through */ }
  }
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]) } catch { /* fall through */ }
  }
  return null
}

function formatPassRate(rates: Record<string, number>): string {
  return Object.entries(rates).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(', ')
}
