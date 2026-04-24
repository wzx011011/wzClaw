// ============================================================
// LLM Prompt 优化器 — 用 LLM 读取 evidence 生成针对性 prompt 增补
// 替代静态规则表，基于 DSPy / Constitutional AI 思路
// ============================================================

import type { WeaknessReport, WeaknessCategory } from './types'

/** LLM 优化器配置 */
export interface LLMPromptOptimizerConfig {
  apiKey: string
  baseURL: string
  model: string
}

/** 增补规则标记前缀（与静态优化器保持兼容） */
const MARKER_PREFIX = '/* EVAL-OPT:'

/**
 * 使用 LLM 根据弱点报告生成针对性的 prompt 增补
 * 与静态 optimizePrompt 接口兼容，可作为 drop-in 替换
 */
export async function optimizePromptWithLLM(
  currentPrompt: string,
  report: WeaknessReport,
  config: LLMPromptOptimizerConfig,
): Promise<{ prompt: string; changes: string[] }> {
  if (report.categories.length === 0) {
    return { prompt: currentPrompt, changes: [] }
  }

  // 过滤掉已应用的规则
  const unapplied = report.categories.filter(c => {
    const marker = `${MARKER_PREFIX} ${c.name} */`
    return !currentPrompt.includes(marker)
  })

  if (unapplied.length === 0) {
    return { prompt: currentPrompt, changes: [] }
  }

  // 批量请求：一次调用生成所有增补
  const additions: string[] = []
  const changes: string[] = []

  // 分批处理（每批最多 5 个弱点，避免 context 过长）
  const batches = chunkArray(unapplied, 5)

  for (const batch of batches) {
    const generated = await generatePromptAdditions(currentPrompt, batch, config)
    for (const item of generated) {
      const marker = `${MARKER_PREFIX} ${item.categoryName} */`
      additions.push(`${marker}\n${item.guidance}`)
      changes.push(`LLM-generated ${item.categoryName} guidance`)
    }
  }

  if (additions.length === 0) {
    return { prompt: currentPrompt, changes: [] }
  }

  const augmentation = `\n\n# Eval-Optimized Guidance\n\n${additions.join('\n\n')}\n`
  return {
    prompt: currentPrompt + augmentation,
    changes,
  }
}

interface GeneratedGuidance {
  categoryName: string
  guidance: string
}

/**
 * 调用 LLM 生成一批弱点的 prompt 增补
 */
async function generatePromptAdditions(
  currentPrompt: string,
  categories: WeaknessCategory[],
  config: LLMPromptOptimizerConfig,
): Promise<GeneratedGuidance[]> {
  const weaknessDescriptions = categories.map((c, i) =>
    `${i + 1}. Category: "${c.name}" (severity: ${c.severity})\n` +
    `   Evidence: ${c.evidence}\n` +
    `   Affected tasks: ${c.affectedTasks.slice(0, 5).join(', ')}${c.affectedTasks.length > 5 ? ` (+${c.affectedTasks.length - 5} more)` : ''}\n` +
    `   Recommendation: ${c.recommendation}`
  ).join('\n\n')

  const systemPrompt = `You are an expert prompt engineer for AI coding agents. Your job is to generate targeted system prompt additions that address specific weaknesses observed in benchmark evaluations.

Rules:
- Each guidance should be 1-3 sentences, concrete and actionable
- Focus on the SPECIFIC weakness pattern shown in the evidence
- Do not repeat generic advice already in the current prompt
- Use imperative style ("Do X", "Always Y", "Never Z")
- Reference the specific language/category/pattern from the evidence
- Output valid JSON array only`

  const userPrompt = `Current system prompt (first 500 chars):
"""
${currentPrompt.slice(0, 500)}${currentPrompt.length > 500 ? '...' : ''}
"""

The following weaknesses were detected in evaluation:

${weaknessDescriptions}

Generate a targeted prompt addition for each weakness. Respond with a JSON array:
[
  {"categoryName": "weakness_name", "guidance": "Your targeted guidance text here"},
  ...
]

Only include entries where you can provide meaningful, specific guidance. Omit categories where the current prompt already addresses the issue.`

  try {
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
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 1000,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(60_000),
    })

    if (!resp.ok) {
      console.log(`  [llm-prompt-optimizer] API error: ${resp.status}`)
      return []
    }

    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
    const raw = data.choices?.[0]?.message?.content ?? ''

    // 提取 JSON（处理 markdown code block）
    let jsonStr = raw
    const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
    if (codeBlockMatch) jsonStr = codeBlockMatch[1]
    const jsonMatch = jsonStr.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      console.log(`  [llm-prompt-optimizer] Could not parse LLM response`)
      return []
    }

    const parsed: GeneratedGuidance[] = JSON.parse(jsonMatch[0])

    // 验证：只保留对应已知 category 的条目
    const validNames = new Set(categories.map(c => c.name))
    return parsed.filter(item =>
      item.categoryName && item.guidance &&
      typeof item.guidance === 'string' &&
      item.guidance.length > 10 &&
      item.guidance.length < 500 &&
      validNames.has(item.categoryName)
    )
  } catch (e: any) {
    console.log(`  [llm-prompt-optimizer] Error: ${e.message}`)
    return []
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}
