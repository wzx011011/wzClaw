// ============================================================
// Langfuse Observer — Agent 可观测性
// 追踪粒度：trace(会话) > generation(LLM调用) > span(工具执行)
//
// 环境变量（可覆盖内置默认值）：
//   LANGFUSE_PUBLIC_KEY  - 默认 wzxClaw 项目 key
//   LANGFUSE_SECRET_KEY  - 默认 wzxClaw 项目 key
//   LANGFUSE_BASE_URL    - 默认 http://192.168.100.78:3000
//   BENCHMARK_TASK_ID    - 可选，设置后所有 trace 携带 task:<id> 标签
//                          用于跨 IDE/模型组合对比同一任务
// ============================================================

import { Langfuse } from 'langfuse'
import { EvalCollector } from './eval-collector'
import { runJudgeEval } from './eval-judge'
import type { Message } from '../../shared/types'

const IDE_NAME = 'wzxclaw'

// ---- 单例 Client ----

let _client: Langfuse | null = null

export function getClient(): Langfuse {
  if (!_client) {
    _client = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? 'pk-lf-53c306d4-557b-4893-a2d2-f5a2683f0d8e',
      secretKey: process.env.LANGFUSE_SECRET_KEY ?? 'sk-lf-1e84dc06-43e9-4721-b2d9-f6b3134e1cc0',
      baseUrl: process.env.LANGFUSE_BASE_URL ?? 'http://192.168.100.78:3000',
      flushAt: 5,
      flushInterval: 3000,
    })
  }
  return _client
}

// ---- 活跃 trace 注册表（按 conversationId） ----

const activeTraces = new Map<string, AgentTraceContext>()

export function startTrace(
  conversationId: string,
  model: string,
  workingDirectory?: string,
): AgentTraceContext {
  const ctx = new AgentTraceContext(conversationId, model, workingDirectory)
  activeTraces.set(conversationId, ctx)
  return ctx
}

export function getActiveTrace(conversationId: string): AgentTraceContext | undefined {
  return activeTraces.get(conversationId)
}

export function endTrace(
  conversationId: string,
  usage: { inputTokens: number; outputTokens: number },
  turnCount: number,
  hadError = false,
  messages?: Message[],
): void {
  const ctx = activeTraces.get(conversationId)
  if (!ctx) return
  ctx.end(usage, turnCount, hadError)

  // 异步触发 LLM Judge（不阻塞主流程）
  if (messages && ctx.evalCollector.totalTurns >= 2) {
    const evalCollector = ctx.evalCollector
    const traceRef = ctx.trace
    const model = ctx.model
    runJudgeEval(evalCollector, messages, traceRef, model).catch(() => {
      // Judge 失败不影响主流程
    })
  }

  activeTraces.delete(conversationId)
}

// ---- Trace 上下文 ----

type LangfuseTrace = ReturnType<Langfuse['trace']>
type LangfuseGeneration = ReturnType<LangfuseTrace['generation']>
type LangfuseSpan = ReturnType<LangfuseTrace['span']>

// ---- 显式 flush + 关闭（headless 评测模式需要） ----

export async function flushLangfuse(): Promise<void> {
  if (_client) {
    await _client.flushAsync()
  }
}

export async function shutdownLangfuse(): Promise<void> {
  if (_client) {
    await _client.flushAsync()
    await _client.shutdownAsync()
    _client = null
  }
}

export class AgentTraceContext {
  private trace: LangfuseTrace
  /** EvalCollector — Agent 运行期间采集质量指标 */
  readonly evalCollector = new EvalCollector()
  /** 当前模型（供 judge 使用） */
  readonly model: string

  constructor(conversationId: string, model: string, workingDirectory?: string) {
    this.model = model
    // Tags: ide + model name (+ optional benchmark task)
    const tags: string[] = [IDE_NAME, model]
    const taskId = process.env.BENCHMARK_TASK_ID
    if (taskId) tags.push(`task:${taskId}`)

    this.trace = getClient().trace({
      id: conversationId,
      name: 'agent-session',
      sessionId: conversationId,
      tags,
      metadata: {
        ide: IDE_NAME,
        model,
        workingDirectory,
        ...(taskId ? { taskId } : {}),
      },
    })
  }

  startGeneration(turnIndex: number, model: string, input: unknown): LangfuseGeneration {
    return this.trace.generation({
      name: `turn-${turnIndex + 1}`,
      model,
      input,
    })
  }

  startToolSpan(toolName: string, input: unknown): LangfuseSpan {
    return this.trace.span({
      name: `tool:${toolName}`,
      input,
    })
  }

  end(
    usage: { inputTokens: number; outputTokens: number },
    turnCount: number,
    hadError: boolean,
  ): void {
    const totalTokens = usage.inputTokens + usage.outputTokens

    this.trace.update({
      output: hadError ? '[error]' : `[done in ${turnCount} turns]`,
      metadata: {
        ide: IDE_NAME,
        totalInputTokens: usage.inputTokens,
        totalOutputTokens: usage.outputTokens,
        turnCount,
        hadError,
      },
    })

    // Numeric scores — mirroring the proxy, makes traces filterable & comparable
    this.trace.score({ name: 'total_tokens', value: totalTokens, dataType: 'NUMERIC' })
    this.trace.score({ name: 'turns_used', value: turnCount, dataType: 'NUMERIC' })
    if (hadError) {
      this.trace.score({ name: 'had_error', value: 1, dataType: 'NUMERIC' })
    }

    // Tier 1 自动评分 — 从 EvalCollector 计算
    for (const score of this.evalCollector.computeScores()) {
      this.trace.score({
        name: score.name,
        value: score.value,
        dataType: score.dataType,
      })
    }

    getClient().flushAsync()
  }
}
