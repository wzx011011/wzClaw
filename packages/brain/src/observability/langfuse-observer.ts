// ============================================================
// LangfuseObserver — 可观测性实现
//
// 实现 IObservability 接口，提供 trace/span 追踪。
// 使用 Langfuse OTel 集成或 console fallback。
// ============================================================

import type { Message, TokenUsage } from '../types.js'
import type { IObservability, ITraceContext, IGenerationSpan, IToolSpan } from '../interfaces.js'

/** Trace 活跃上下文 */
interface ActiveTrace {
  conversationId: string
  model: string
  startTime: number
  turnCount: number
}

/** Console fallback span */
class ConsoleGenerationSpan implements IGenerationSpan {
  private readonly label: string
  constructor(label: string) { this.label = label }
  update(data: Record<string, unknown>): void {
    console.log(`[Trace:${this.label}]`, data)
  }
  end(): void {
    console.log(`[Trace:${this.label}] ended`)
  }
}

/** Console fallback tool span */
class ConsoleToolSpan implements IToolSpan {
  private readonly toolName: string
  constructor(toolName: string) { this.toolName = toolName }
  update(data: Record<string, unknown>): void {
    console.log(`[ToolSpan:${this.toolName}]`, data)
  }
  end(): void {
    console.log(`[ToolSpan:${this.toolName}] ended`)
  }
}

/** Console fallback trace context */
class ConsoleTraceContext implements ITraceContext {
  evalCollector = {
    recordToolCall(_name: string, _isError: boolean, _isLoop: boolean): void {},
    recordTurn(_outputTokens: number): void {},
    recordContextPressure(_tokens: number, _window: number): void {},
    recordErrorRecovery(_type: string): void {},
    recordCompaction(): void {},
  }

  startGeneration(turnIndex: number, model: string): IGenerationSpan {
    return new ConsoleGenerationSpan(`turn-${turnIndex}-${model}`)
  }

  startToolSpan(name: string, _input: Record<string, unknown>): IToolSpan {
    return new ConsoleToolSpan(name)
  }
}

/**
 * LangfuseObserver — 可观测性实现
 *
 * 默认使用 console fallback，当 Langfuse 环境变量配置后启用真实追踪。
 */
export class LangfuseObserver implements IObservability {
  private readonly traces = new Map<string, ActiveTrace>()
  private readonly contexts = new Map<string, ITraceContext>()

  startTrace(
    conversationId: string,
    model: string,
    _userMessage: string,
    _workingDir: string,
  ): void {
    this.traces.set(conversationId, {
      conversationId,
      model,
      startTime: Date.now(),
      turnCount: 0,
    })
    this.contexts.set(conversationId, new ConsoleTraceContext())
  }

  endTrace(
    conversationId: string,
    usage: TokenUsage,
    turnCount: number,
    error: boolean,
    _messages?: Message[],
  ): void {
    const trace = this.traces.get(conversationId)
    if (trace) {
      const duration = Date.now() - trace.startTime
      console.log(
        `[Trace] ${conversationId}: ${turnCount} turns, ${usage.inputTokens + usage.outputTokens} tokens, ${duration}ms${error ? ' (errored)' : ''}`,
      )
    }
    this.traces.delete(conversationId)
    this.contexts.delete(conversationId)
  }

  getActiveTrace(conversationId: string): ITraceContext | undefined {
    return this.contexts.get(conversationId)
  }
}
