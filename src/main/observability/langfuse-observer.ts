// ============================================================
// Langfuse Observer — Agent 可观测性
// 追踪粒度：trace(会话) > generation(LLM调用) > span(工具执行)
//
// 环境变量：
//   LANGFUSE_PUBLIC_KEY  - 默认 pk-lf-claude-code
//   LANGFUSE_SECRET_KEY  - 默认 sk-lf-claude-code
//   LANGFUSE_BASE_URL    - 默认 http://192.168.100.78:3000
//   BENCHMARK_TASK_ID    - 可选，设置后所有 trace 携带 task:<id> 标签
//                          用于跨 IDE/模型组合对比同一任务
// ============================================================

import { Langfuse } from 'langfuse'

const IDE_NAME = 'wzxclaw'

// ---- 单例 Client ----

let _client: Langfuse | null = null

function getClient(): Langfuse {
  if (!_client) {
    _client = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? 'pk-lf-claude-code',
      secretKey: process.env.LANGFUSE_SECRET_KEY ?? 'sk-lf-claude-code',
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
): void {
  const ctx = activeTraces.get(conversationId)
  if (!ctx) return
  ctx.end(usage, turnCount, hadError)
  activeTraces.delete(conversationId)
}

// ---- Trace 上下文 ----

type LangfuseTrace = ReturnType<Langfuse['trace']>
type LangfuseGeneration = ReturnType<LangfuseTrace['generation']>
type LangfuseSpan = ReturnType<LangfuseTrace['span']>

export class AgentTraceContext {
  private trace: LangfuseTrace

  constructor(conversationId: string, model: string, workingDirectory?: string) {
    // Tags: ide + model name (+ optional benchmark task)
    const tags: string[] = [IDE_NAME, model]
    const taskId = process.env.BENCHMARK_TASK_ID
    if (taskId) tags.push(`task:${taskId}`)

    this.trace = getClient().trace({
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

    getClient().flushAsync()
  }
}
