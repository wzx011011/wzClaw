// ============================================================
// 逐工作区轨迹分析器 — 从 TaskTraceData 中检测失败模式
// Tier 1: 基于规则（零 LLM 开销），7 种 SWE-bench 风格失败模式
// Tier 2: LLM 深度分析（仅用于规则无法分类的失败工作区）
// ============================================================

import type { TaskTraceData, TaskEvalResult, FailureClassification } from './types'

/** 规则分类器检测结果 */
interface RuleClassification {
  failureMode: string
  taxonomy: FailureClassification['taxonomy']
  rootCause: string
  recoverable: boolean
  suggestedPromptFix: string
}

/**
 * Tier 1: 基于规则的失败分类
 * 返回 null 表示需要 Tier 2 LLM 分析
 */
export function classifyFailureRuleBased(
  trace: TaskTraceData,
  result: TaskEvalResult,
): RuleClassification | null {
  // 只分析测试失败的工作区
  if (result.testPassed === true || result.testPassed === null) return null

  const { toolCallSequence, firstEditAttempt, ranTestBeforeDone, readsBeforeFirstEdit, errorCount, hitMaxTurns } = trace

  // 1. 没跑测试就结束了
  if (!ranTestBeforeDone && result.testPassed === false) {
    return {
      failureMode: 'no_test_run',
      taxonomy: 'iteration',
      rootCause: 'Agent did not run the test command before finishing',
      recoverable: true,
      suggestedPromptFix: 'After implementing your solution, you MUST run the test command to verify correctness before finishing.',
    }
  }

  // 2. 触达最大轮次
  if (hitMaxTurns) {
    return {
      failureMode: 'max_turns_hit',
      taxonomy: 'iteration',
      rootCause: 'Agent exhausted max turns without solving the task',
      recoverable: true,
      suggestedPromptFix: 'Be efficient: plan first, then implement in minimal steps. Avoid re-reading files you have already seen.',
    }
  }

  // 3. 第一次编辑就错了
  if (firstEditAttempt && firstEditAttempt.isError) {
    return {
      failureMode: 'first_edit_wrong',
      taxonomy: 'repair',
      rootCause: `First file edit (${firstEditAttempt.tool}) failed at turn ${firstEditAttempt.turn}`,
      recoverable: true,
      suggestedPromptFix: 'Before editing, read the file to understand its current content. Ensure your old_string matches exactly.',
    }
  }

  // 4. 没读文件就编辑
  if (readsBeforeFirstEdit === 0 && firstEditAttempt) {
    return {
      failureMode: 'no_read_before_edit',
      taxonomy: 'localization',
      rootCause: 'Agent edited a file without reading it first',
      recoverable: true,
      suggestedPromptFix: 'Always read a file before editing it. Use FileRead to understand current content, then apply targeted edits.',
    }
  }

  // 5. 大量工具错误
  if (errorCount >= 3) {
    return {
      failureMode: 'tool_errors',
      taxonomy: 'environment',
      rootCause: `${errorCount} tool call errors during execution`,
      recoverable: false,
      suggestedPromptFix: 'When a tool call fails, read the error message carefully and adjust your approach. Common issues: file paths must be relative to workspace, shell commands must use correct syntax.',
    }
  }

  // 6. 循环停滞（相同工具调用重复 3+ 次）
  const stallDetected = detectStallCycle(toolCallSequence)
  if (stallDetected) {
    return {
      failureMode: 'stall_cycle',
      taxonomy: 'iteration',
      rootCause: `Agent is cycling: repeated the same action ${stallDetected.count} times`,
      recoverable: true,
      suggestedPromptFix: 'If your approach is not working after 2 attempts, try a completely different strategy. Do not repeat the same failed action.',
    }
  }

  // 7. 盲目编辑（编辑了源码但没读测试文件）
  const blindEdit = detectBlindEdit(toolCallSequence)
  if (blindEdit) {
    return {
      failureMode: 'blind_edit',
      taxonomy: 'localization',
      rootCause: 'Agent edited source files without reading the test file first',
      recoverable: true,
      suggestedPromptFix: 'Before implementing, read the test file to understand expected behavior and edge cases. Implement the solution to satisfy all test cases.',
    }
  }

  // 规则无法分类，返回 null 触发 Tier 2
  return null
}

/** 检测循环停滞 */
function detectStallCycle(
  sequence: TaskTraceData['toolCallSequence'],
): { count: number } | null {
  if (sequence.length < 6) return null

  // 检查最后 6 次调用是否有连续重复模式
  const window = sequence.slice(-6)
  const toolNames = window.map(t => t.tool)

  // 计算连续相同工具调用的最大次数
  let maxRepeat = 1
  let currentRepeat = 1
  for (let i = 1; i < toolNames.length; i++) {
    if (toolNames[i] === toolNames[i - 1]) {
      currentRepeat++
      maxRepeat = Math.max(maxRepeat, currentRepeat)
    } else {
      currentRepeat = 1
    }
  }

  return maxRepeat >= 3 ? { count: maxRepeat } : null
}

/** 检测盲目编辑（有编辑但没有读测试文件） */
function detectBlindEdit(
  sequence: TaskTraceData['toolCallSequence'],
): boolean {
  let hasEdit = false
  let hasReadTest = false

  for (const tc of sequence) {
    if (tc.tool === 'FileEdit' || tc.tool === 'FileWrite') hasEdit = true
    // 测试文件通常包含 test_ 前缀或 _test 后缀或 spec
    if (tc.tool === 'FileRead' || tc.tool === 'Grep' || tc.tool === 'Glob') {
      // 简化：只要读了文件就算，具体是否是测试文件难以从 trace 判断
      hasReadTest = true
    }
  }

  return hasEdit && !hasReadTest
}

/**
 * Tier 2: LLM 深度失败分析
 * 仅在规则分类器返回 null 时调用
 */
export async function analyzeFailureWithLLM(
  taskDescription: string,
  result: TaskEvalResult,
  trace: TaskTraceData,
  config: { apiKey: string; baseURL: string; model: string },
): Promise<FailureClassification> {
  const prompt = buildAnalysisPrompt(taskDescription, result, trace)

  try {
    const response = await callLlmForAnalysis(prompt, config)
    const parsed = extractJson(response)
    if (parsed) {
      return {
        taskId: result.taskId,
        taxonomy: validateTaxonomy(parsed.taxonomy),
        failureMode: String(parsed.failureMode ?? 'unknown'),
        criticalTurn: Number(parsed.criticalTurn) || 0,
        rootCause: String(parsed.rootCause ?? ''),
        recoverable: Boolean(parsed.recoverable),
        suggestedPromptFix: String(parsed.suggestedPromptFix ?? ''),
        analysisSource: 'llm',
      }
    }
  } catch { /* fall through to fallback */ }

  // LLM 分析失败，返回 unknown
  return {
    taskId: result.taskId,
    taxonomy: 'unknown',
    failureMode: 'unclassified',
    criticalTurn: 0,
    rootCause: 'Could not classify failure',
    recoverable: false,
    suggestedPromptFix: '',
    analysisSource: 'llm',
  }
}

function buildAnalysisPrompt(
  taskDescription: string,
  result: TaskEvalResult,
  trace: TaskTraceData,
): string {
  const toolSeq = trace.toolCallSequence
    .slice(0, 20)
    .map(tc => `  T${tc.turn}: ${tc.tool}${tc.isError ? ' (ERROR)' : ''}`)
    .join('\n')

  return `Analyze why a coding agent failed this task.

Task: ${taskDescription.slice(0, 500)}
Test result: ${result.testPassed ? 'PASS' : 'FAIL'}
Turns used: ${result.turnCount}

Tool call sequence:
${toolSeq || '  (none)'}

Test output (last 500 chars):
${trace.testOutput?.slice(-500) ?? '(not available)'}

Agent's final message (last 500 chars):
${trace.finalAssistantText.slice(-500) ?? '(empty)'}

Classify the failure using this taxonomy:
- localization: Agent found the wrong code location or misunderstood the problem
- repair: Agent found the right location but applied a wrong fix
- iteration: Agent looped, timed out, or failed to iterate effectively
- environment: Tool errors, API failures, or infrastructure issues
- knowledge: Agent lacks domain knowledge to solve the task

Respond with JSON only:
{
  "taxonomy": "localization|repair|iteration|environment|knowledge",
  "failureMode": "short_snake_case_name",
  "criticalTurn": <turn number where agent first went wrong>,
  "rootCause": "one sentence explaining the root cause",
  "recoverable": <true if retry with guidance could help>,
  "suggestedPromptFix": "specific prompt guidance that would prevent this failure"
}`
}

async function callLlmForAnalysis(
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
        { role: 'system', content: 'You are a coding agent failure analyst. Respond only with valid JSON.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 300,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(30_000),
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

function validateTaxonomy(val: unknown): FailureClassification['taxonomy'] {
  const valid = ['localization', 'repair', 'iteration', 'environment', 'knowledge']
  if (typeof val === 'string' && valid.includes(val)) return val as FailureClassification['taxonomy']
  return 'unknown'
}

/**
 * 便捷入口：对单个失败工作区运行两层分析
 */
export async function analyzeTaskFailure(
  taskDescription: string,
  result: TaskEvalResult,
  trace: TaskTraceData,
  llmConfig?: { apiKey: string; baseURL: string; model: string },
): Promise<FailureClassification> {
  // Tier 1: 规则分类
  const ruleResult = classifyFailureRuleBased(trace, result)
  if (ruleResult) {
    return {
      taskId: result.taskId,
      ...ruleResult,
      criticalTurn: ruleResult.failureMode === 'no_read_before_edit' && trace.firstEditAttempt
        ? trace.firstEditAttempt.turn
        : 0,
      analysisSource: 'rule',
    }
  }

  // Tier 2: LLM 分析（需要配置）
  if (llmConfig) {
    return analyzeFailureWithLLM(taskDescription, result, trace, llmConfig)
  }

  // 无 LLM 配置，返回 unknown
  return {
    taskId: result.taskId,
    taxonomy: 'unknown',
    failureMode: 'unclassified_no_llm',
    criticalTurn: 0,
    rootCause: 'Rule-based classifier could not determine cause and no LLM config provided',
    recoverable: false,
    suggestedPromptFix: '',
    analysisSource: 'rule',
  }
}
