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

import { NodeSDK } from '@opentelemetry/sdk-node'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { LangfuseClient } from '@langfuse/client'
import {
  propagateAttributes,
  startObservation,
  type LangfuseGeneration,
  type LangfuseObservation,
  type LangfuseSpan,
  type LangfuseTool,
} from '@langfuse/tracing'
import { EvalCollector } from './eval-collector'
import { runJudgeEval } from './eval-judge'
import type { Message } from '../../shared/types'

const IDE_NAME = 'wzxclaw'
const DEFAULT_BASE_URL = 'http://192.168.100.78:3000'

function getLangfuseConfig() {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY
  const secretKey = process.env.LANGFUSE_SECRET_KEY
  if (!publicKey || !secretKey) {
    return null
  }
  return {
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_BASE_URL ?? DEFAULT_BASE_URL,
  }
}

// ---- OTel SDK + API Client 单例 ----

let _sdk: NodeSDK | null = null
let _client: LangfuseClient | null = null
let _spanProcessor: LangfuseSpanProcessor | null = null

export function initLangfuse(): void {
  if (_sdk) return

  const cfg = getLangfuseConfig()
  if (!cfg) return

  _spanProcessor = new LangfuseSpanProcessor({
    ...cfg,
    flushAt: 1,
    flushInterval: 3,
    // Observation-level evaluators in Langfuse Fast Mode use this OTLP ingestion
    // version marker to enable real-time observation evaluation.
    additionalHeaders: { 'x-langfuse-ingestion-version': '4' },
    // v5 默认只导出 LLM / Langfuse spans；这里保留升级前「全部自定义 span」行为。
    shouldExportSpan: () => true,
  })
  _sdk = new NodeSDK({
    spanProcessors: [_spanProcessor],
  })
  _sdk.start()
}

export function getClient(): LangfuseClient | null {
  if (!_client) {
    const cfg = getLangfuseConfig()
    if (!cfg) return null
    _client = new LangfuseClient(cfg)
  }
  return _client
}

// ---- 活跃 trace 注册表（按 conversationId） ----

const activeTraces = new Map<string, AgentTraceContext>()

export function startTrace(
  conversationId: string,
  model: string,
  userInput: string,
  workingDirectory?: string,
  parentSpan?: unknown,
): AgentTraceContext {
  initLangfuse()
  const ctx = new AgentTraceContext(conversationId, model, userInput, workingDirectory, parentSpan)
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
  ctx.end(usage, turnCount, hadError, messages)

  // 异步触发 LLM Judge（不阻塞主流程）。Nested 模式不单独打分。
  if (messages && !ctx.isNestedTrace && ctx.evalCollector.totalTurns >= 2) {
    const evalCollector = ctx.evalCollector
    const traceId = ctx.traceId
    const model = ctx.model
    runJudgeEval(evalCollector, messages, traceId, model).catch(() => {
      // Judge 失败不影响主流程
    })
  }

  activeTraces.delete(conversationId)
}

function getFinalAssistantOutput(messages?: Message[]): string | undefined {
  if (!messages) return undefined

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    if (typeof message.content !== 'string') continue
  }

  return undefined
}

function toScoreValue(value: unknown): number | string {
  return typeof value === 'number' ? value : String(value)
}

// ---- 显式 flush + 关闭（headless 评测模式需要） ----

export async function flushLangfuse(): Promise<void> {
  await Promise.all([
    _client?.flush() ?? Promise.resolve(),
    _spanProcessor?.forceFlush() ?? Promise.resolve(),
  ])
}

export async function shutdownLangfuse(): Promise<void> {
  await flushLangfuse()
  await _client?.shutdown()
  await _sdk?.shutdown()
  _client = null
  _sdk = null
  _spanProcessor = null
}

export class AgentTraceContext {
  /** Root 模式下的会话根 observation；Nested 模式为 null。 */
  readonly trace: LangfuseSpan | null
  /** 当前 observation 所属 trace id，供 score API / E2E 查询使用。 */
  readonly traceId: string
  /** 实际用于创建子 observations 的父对象。 */
  private readonly parent: LangfuseObservation
  private readonly isNested: boolean
  /** EvalCollector — Agent 运行期间采集质量指标 */
  readonly evalCollector = new EvalCollector()
  /** 当前模型（供 judge 使用） */
  readonly model: string

  get isNestedTrace(): boolean {
    return this.isNested
  }

  constructor(
    conversationId: string,
    model: string,
    userInput: string,
    workingDirectory?: string,
    parentSpan?: unknown,
  ) {
    this.model = model
    this.isNested = parentSpan != null

    if (this.isNested) {
      // Nested 模式：子 Agent 不创建独立 trace，直接挂在父 tool:Agent observation 下。
      this.trace = null
      this.parent = parentSpan as LangfuseObservation
      this.traceId = this.parent.traceId
      return
    }

    const tags: string[] = [IDE_NAME, model]
    const taskId = process.env.BENCHMARK_TASK_ID
    if (taskId) tags.push(`task:${taskId}`)

    const metadata: Record<string, string> = {
      ide: IDE_NAME,
      model,
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(taskId ? { taskId } : {}),
    }

    // v5 中 trace 级属性通过 propagateAttributes 写入当前上下文；root observation
    // 用 setTraceIO 兼容现有 LLM-as-Judge / trace-level input/output。
    const root = propagateAttributes({
      traceName: 'agent-session',
      sessionId: conversationId,
      tags,
      metadata,
    }, () => startObservation('agent-session', {
      input: userInput,
      metadata: {
        ide: IDE_NAME,
        model,
        workingDirectory,
        ...(taskId ? { taskId } : {}),
      },
    }))

    root.setTraceIO({ input: userInput })
    this.trace = root
    this.parent = root
    this.traceId = root.traceId
  }

  startGeneration(turnIndex: number, model: string, input: unknown): LangfuseGeneration {
    return this.parent.startObservation(
      `${this.isNested ? 'sub-' : ''}turn-${turnIndex + 1}`,
      { model, input },
      { asType: 'generation' },
    )
  }

  startToolSpan(toolName: string, input: unknown): LangfuseTool | LangfuseSpan {
    return this.parent.startObservation(
      `tool:${toolName}`,
      { input },
      { asType: 'tool' },
    )
  }

  end(
    usage: { inputTokens: number; outputTokens: number },
    turnCount: number,
    hadError: boolean,
    messages?: Message[],
  ): void {
    if (this.isNested) {
      flushLangfuse().catch(() => {/* 忽略 flush 错误 */})
      return
    }

    const totalTokens = usage.inputTokens + usage.outputTokens
    const finalOutput = getFinalAssistantOutput(messages)
    const output = hadError ? '[error]' : (finalOutput ?? `[done in ${turnCount} turns]`)

    this.trace!.update({
      output,
      metadata: {
        ide: IDE_NAME,
        totalInputTokens: usage.inputTokens,
        totalOutputTokens: usage.outputTokens,
        turnCount,
        hadError,
      },
      level: hadError ? 'ERROR' : 'DEFAULT',
    })
    this.trace!.setTraceIO({ output })

    const client = getClient()
    if (client) {
      client.score.create({ traceId: this.traceId, name: 'total_tokens', value: totalTokens, dataType: 'NUMERIC' })
      client.score.create({ traceId: this.traceId, name: 'turns_used', value: turnCount, dataType: 'NUMERIC' })
      if (hadError) {
        client.score.create({ traceId: this.traceId, name: 'had_error', value: 1, dataType: 'NUMERIC' })
      }

      // Tier 1 自动评分 — 从 EvalCollector 计算
      for (const score of this.evalCollector.computeScores()) {
        client.score.create({
          traceId: this.traceId,
          name: score.name,
          value: toScoreValue(score.value),
          dataType: score.dataType,
        })
      }
    }

    this.trace!.end()
    flushLangfuse().catch(() => {/* 忽略 flush 错误 */})
  }
}
