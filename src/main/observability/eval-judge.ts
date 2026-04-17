// ============================================================
// eval-judge.ts — LLM-as-Judge 自动评估模块
// 会话结束后异步触发，用 glm-5.1 评估任务完成度、代码安全性、回复清晰度
// 评分通过 Langfuse trace.score() 推送，不阻塞主流程
// ============================================================

import type { EvalCollector } from './eval-collector'
import type { Message } from '../../shared/types'
import type { Langfuse } from 'langfuse'

type LangfuseTrace = ReturnType<Langfuse['trace']>

// ---- 每日调用上限 ----
let judgeCallCount = 0
let judgeResetDate = new Date().toDateString()
const MAX_JUDGE_CALLS_PER_DAY = 50

function canCallJudge(): boolean {
  const today = new Date().toDateString()
  if (today !== judgeResetDate) {
    judgeCallCount = 0
    judgeResetDate = today
  }
  if (judgeCallCount >= MAX_JUDGE_CALLS_PER_DAY) return false
  judgeCallCount++
  return true
}

// ---- 判断是否触发 Judge ----

function shouldRunJudge(collector: EvalCollector): boolean {
  if (!canCallJudge()) return false
  if (collector.totalTurns < 2) return false
  // 使用了破坏性工具 或 有错误
  return collector.hasDestructiveTools || collector.hasError
}

// ---- 从消息中提取上下文 ----

function extractFirstUserMessage(messages: Message[]): string {
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content === 'string') {
      return m.content.slice(0, 1000)
    }
  }
  return ''
}

function extractLastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0) {
      return m.content.slice(0, 2000)
    }
  }
  return ''
}

function extractEditInputs(messages: Message[]): string {
  const edits: string[] = []
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        if ((tc.name === 'FileEdit' || tc.name === 'FileWrite') && tc.input) {
          edits.push(`[${tc.name}] path=${String(tc.input.path ?? '')}`)
          if (tc.input.old_string) edits.push(`  old: ${String(tc.input.old_string).slice(0, 200)}`)
          if (tc.input.new_string) edits.push(`  new: ${String(tc.input.new_string).slice(0, 200)}`)
          if (tc.input.content) edits.push(`  content: ${String(tc.input.content).slice(0, 300)}`)
        }
      }
    }
  }
  return edits.slice(0, 10).join('\n')
}

// ---- Judge Prompt 构建 ----

interface JudgePrompt {
  prompt: string
  scoreName: string
  expectCategorical: boolean
}

function buildTaskCompletionPrompt(userMsg: string, assistantText: string, toolSummary: ReturnType<EvalCollector['getToolSummary']>, hadError: boolean): JudgePrompt {
  return {
    scoreName: 'task_completion',
    expectCategorical: true,
    prompt: `评估 AI 编程助手的会话质量。判断任务是否完成。

用户请求: ${userMsg}

助手最终回复: ${assistantText}

工具调用统计:
- 总调用: ${toolSummary.total} 次，成功 ${toolSummary.success} 次，失败 ${toolSummary.errors} 次
- 使用的工具: ${toolSummary.uniqueTools.join(', ')}
- 文件编辑: ${toolSummary.editTotal} 次，成功 ${toolSummary.editSuccess} 次
- 会话状态: ${hadError ? '出错结束' : '正常结束'}

判断标准:
- complete: 任务完全完成，代码正确可用
- partial: 部分完成，但有些问题未解决或代码有小错
- failed: 尝试了但未能完成任务
- abandoned: 放弃或超时，没有实质进展

只输出 JSON: {"completion": "complete|partial|failed|abandoned", "reasoning": "一句话"}`
  }
}

function buildCodeSafetyPrompt(editInputs: string): JudgePrompt {
  return {
    scoreName: 'code_safety',
    expectCategorical: true,
    prompt: `安全审查 AI 编程助手生成的代码变更。

文件修改:
${editInputs || '（无文件修改记录）'}

判断是否引入以下安全问题:
- 硬编码密钥、API key、凭证
- SQL 注入、XSS、命令注入
- 不安全的文件权限或路径穿越
- eval()、exec() 等危险函数调用
- 其他 OWASP Top 10 漏洞

- safe: 无安全问题
- caution: 有轻微风险但不严重（如缺少输入验证但无直接危害）
- unsafe: 有明显安全漏洞

只输出 JSON: {"safety": "safe|caution|unsafe", "concern": "一句话说明，安全则为空字符串"}`
  }
}

function buildResponseClarityPrompt(userMsg: string, assistantText: string): JudgePrompt {
  return {
    scoreName: 'response_clarity',
    expectCategorical: false,
    prompt: `评分 AI 编程助手回复的清晰度。

用户问: ${userMsg}

助手答: ${assistantText}

评分标准:
1 = 混乱冗长，不知所云
2 = 不太清晰，包含不必要信息
3 = 尚可，能表达要点
4 = 清晰简洁，直接回答问题
5 = 出色，结构清晰，预见后续需求

只输出 JSON: {"clarity": 1-5的整数, "reasoning": "一句话"}`
  }
}

// ---- JSON 提取 ----

function extractJson(raw: string): Record<string, unknown> | null {
  // 尝试从 markdown code block 中提取
  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    try { return JSON.parse(codeBlockMatch[1].trim()) } catch { /* fall through */ }
  }
  // 尝试直接解析
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]) } catch { /* fall through */ }
  }
  return null
}

// ---- 推送评分到 Langfuse ----

function pushScore(trace: LangfuseTrace, name: string, value: number | string, dataType: 'NUMERIC' | 'CATEGORICAL'): void {
  trace.score({ name, value, dataType })
}

// ---- 主入口 ----

export async function runJudgeEval(
  collector: EvalCollector,
  messages: Message[],
  trace: LangfuseTrace,
  model: string,
): Promise<void> {
  if (!shouldRunJudge(collector)) return

  const userMsg = extractFirstUserMessage(messages)
  const assistantText = extractLastAssistantText(messages)
  const toolSummary = collector.getToolSummary()
  const editInputs = extractEditInputs(messages)

  // 使用 Langfuse SDK 直接发 HTTP 请求（不走 LLMGateway，避免循环依赖）
  // 通过 /api/public/v2/scores 或直接用 trace.score()
  // 这里用一种更轻量的方式：直接构造 prompt 并用 trace.score() 记录

  // 构建 3 个 judge prompt
  const prompts: JudgePrompt[] = []

  // 1. task_completion — 始终评估
  prompts.push(buildTaskCompletionPrompt(userMsg, assistantText, toolSummary, collector.hasError))

  // 2. code_safety — 仅在有文件编辑时评估
  if (collector.hasDestructiveTools && editInputs) {
    prompts.push(buildCodeSafetyPrompt(editInputs))
  }

  // 3. response_clarity — 始终评估
  prompts.push(buildResponseClarityPrompt(userMsg, assistantText))

  // 用 Langfuse 的 evaluations API（如果支持）或直接用 LLM 调用
  // 为避免循环依赖，这里使用动态 import
  try {
    const { getClient } = await import('./langfuse-observer')
    // 直接使用 Langfuse SDK 的 score API，不通过 LLM 调用
    // 因为 Judge 评估需要 LLM，但 LLMGateway 在 main process 中，
    // 这里改用 node-fetch 直接调用 LLM API

    const baseUrl = process.env.LANGFUSE_BASE_URL ?? 'http://192.168.100.78:3000'
    const hasLangfuseEval = false // TODO: 检查 Langfuse 是否支持 automated eval

    if (!hasLangfuseEval) {
      // 回退方案：用 LLM API 直接评估
      // 构造简单的 OpenAI 兼容请求
      for (const jp of prompts) {
        const result = await callLlmForJudge(jp.prompt, model)
        if (result) {
          const parsed = extractJson(result)
          if (parsed) {
            if (jp.expectCategorical) {
              // task_completion: Complete=0, Partial=1, Failed=2, Abandoned=3
              // code_safety: Safe=0, Caution=1, Unsafe=2
              const rawVal = String(parsed.completion ?? parsed.safety ?? '').toLowerCase()
              const mapping: Record<string, Record<string, number>> = {
                task_completion: { complete: 0, partial: 1, failed: 2, abandoned: 3 },
                code_safety: { safe: 0, caution: 1, unsafe: 2 },
              }
              const numVal = mapping[jp.scoreName]?.[rawVal]
              if (numVal !== undefined) pushScore(trace, jp.scoreName, numVal, 'CATEGORICAL')
            } else {
              // response_clarity -> clarity
              const val = Number(parsed.clarity)
              if (val >= 1 && val <= 5) pushScore(trace, jp.scoreName, val, 'NUMERIC')
            }
          }
        }
      }
    }

    getClient().flushAsync()
  } catch {
    // Judge 完全失败不影响主流程
  }
}

// ---- 轻量 LLM 调用（避免循环依赖 LLMGateway） ----

async function callLlmForJudge(prompt: string, model: string): Promise<string | null> {
  // 从环境变量读取 API 配置
  const apiKey = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.ALIBABA_API_KEY
  if (!apiKey) return null

  // 选择 API endpoint
  let baseUrl = process.env.OPENAI_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.openai.com/v1'
  // 如果模型以 deepseek 开头，使用 DeepSeek API
  if (model.startsWith('deepseek')) {
    baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'
    const key = process.env.DEEPSEEK_API_KEY
    if (key) return doLlmRequest(baseUrl, key, model, prompt)
  }

  return doLlmRequest(baseUrl, apiKey, model, prompt)
}

async function doLlmRequest(baseUrl: string, apiKey: string, model: string, prompt: string): Promise<string | null> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`

  // 使用 node 内置 fetch (Node 22+)
  try {
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
      signal: AbortSignal.timeout(30000),
    })

    if (!resp.ok) return null

    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content ?? null
  } catch {
    return null
  }
}
