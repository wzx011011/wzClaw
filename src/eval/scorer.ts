// ============================================================
// 多层评分器 — Layer A (测试执行) + Layer C (LLM Judge)
// Layer B (EvalCollector 自动指标) 由 langfuse-observer 自动完成
// ============================================================

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { BenchmarkTask, TaskEvalResult, HeadlessRunResult } from './types'

const execAsync = promisify(execFile)

// ---- Layer A: 测试执行（客观判定） ----

/**
 * 在工作空间中执行测试命令，判定 pass/fail
 * 命令中的 $WORKSPACE 会被替换为实际路径
 */
export async function scoreTestExecution(
  workspaceDir: string | undefined,
  testCommand: string | undefined,
): Promise<{ passed: boolean | null; output: string }> {
  if (!testCommand || !workspaceDir) {
    return { passed: null, output: 'No test command provided' }
  }

  const resolvedCmd = testCommand.replace(/\$WORKSPACE/g, workspaceDir)

  try {
    const { stdout, stderr } = await execAsync(resolvedCmd, {
      shell: true,
      timeout: 60_000,
      cwd: workspaceDir,
    })
    return { passed: true, output: (stdout + '\n' + stderr).trim() }
  } catch (err: any) {
    const output = (err?.stdout ?? '') + '\n' + (err?.stderr ?? '') + '\n' + (err?.message ?? '')
    return { passed: false, output: output.trim() }
  }
}

// ---- Layer C: LLM Judge（增强版 benchmark 评估） ----

interface JudgeResult {
  scores: Record<string, number>
  reasoning: string
}

/**
 * 使用 LLM 评估 agent 的输出质量
 * 复用 eval-judge.ts 的 HTTP 直调模式，避免循环依赖
 */
export async function scoreWithJudge(
  task: BenchmarkTask,
  result: HeadlessRunResult,
  apiKey: string,
  baseURL: string,
  model: string,
): Promise<JudgeResult> {
  const lastAssistantText = result.messages
    .filter(m => m.role === 'assistant' && m.content.length > 0)
    .map(m => m.content)
    .pop() ?? ''

  const toolCalls = result.events
    .filter(e => e.type === 'agent:tool_call')
    .map(e => (e as any).toolName)
  const toolErrors = result.events
    .filter(e => e.type === 'agent:tool_result' && (e as any).isError)
    .length

  const prompt = `You are evaluating an AI coding agent's performance on a benchmark task.

Task: ${task.description}
Difficulty: ${task.difficulty}
Language: ${task.language}

Agent's Final Output: ${lastAssistantText.slice(0, 2000)}

Tool Usage Summary:
- Total tool calls: ${toolCalls.length}
- Tool errors: ${toolErrors}
- Tools used: ${[...new Set(toolCalls)].join(', ')}
- Turns: ${result.turnCount}
- Duration: ${(result.duration / 1000).toFixed(1)}s

Score the following dimensions (1-5):
1. task_completion: Did the agent correctly solve the problem?
2. code_quality: Is the solution clean, idiomatic, and well-structured?
3. efficiency: Did the agent use tools effectively without unnecessary iterations?
4. error_handling: How well did the agent handle obstacles?

Respond ONLY with valid JSON:
{"task_completion": N, "code_quality": N, "efficiency": N, "error_handling": N, "reasoning": "one sentence"}`

  try {
    const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a code quality evaluator. Respond only with valid JSON.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 200,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!resp.ok) return { scores: {}, reasoning: `Judge API error: ${resp.status}` }

    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
    const raw = data.choices?.[0]?.message?.content ?? ''

    // 提取 JSON（支持 markdown 代码块包裹）
    let jsonStr = raw
    const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1]
    }
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { scores: {}, reasoning: `Could not parse judge response: ${raw.slice(0, 200)}` }

    const parsed = JSON.parse(jsonMatch[0])
    return {
      scores: {
        task_completion: Number(parsed.task_completion) || 0,
        code_quality: Number(parsed.code_quality) || 0,
        efficiency: Number(parsed.efficiency) || 0,
        error_handling: Number(parsed.error_handling) || 0,
      },
      reasoning: String(parsed.reasoning ?? ''),
    }
  } catch {
    return { scores: {}, reasoning: 'Judge evaluation failed' }
  }
}

/**
 * 完整评分流水线：A + C 层（B 层由 langfuse-observer 自动完成）
 */
export async function scoreTask(
  task: BenchmarkTask,
  result: HeadlessRunResult,
  workspaceDir: string | undefined,
  config: { apiKey: string; baseURL: string; judgeModel: string },
): Promise<TaskEvalResult> {
  // Layer A: 测试执行
  const testResult = await scoreTestExecution(workspaceDir, task.testCommand)

  // Layer C: LLM Judge（apiKey 为空时跳过）
  const judgeResult = config.apiKey
    ? await scoreWithJudge(task, result, config.apiKey, config.baseURL, config.judgeModel)
    : { scores: {} as Record<string, number>, reasoning: 'Judge skipped (no API key)' }

  return {
    taskId: task.id,
    taskSource: task.source,
    language: task.language,
    difficulty: task.difficulty,
    testPassed: testResult.passed,
    testOutput: testResult.output,
    autoScores: {},  // Layer B 从 Langfuse 拉取，batch-runner 中填充
    judgeScores: judgeResult.scores,
    judgeReasoning: judgeResult.reasoning,
    turnCount: result.turnCount,
    duration: result.duration,
    traceId: result.traceId,
    patch: result.patch,
  }
}
