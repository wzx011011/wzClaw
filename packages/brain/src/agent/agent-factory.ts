// ============================================================
// AgentFactory — 创建 AgentLoop 实例的工厂函数
// 集中依赖注入，简化调用方代码
// ============================================================

import type {
  IStreamProvider,
  IContextManager,
  IObservability,
  IHookRegistry,
  ILogger,
} from '../interfaces.js'
import { AgentLoop } from './agent-loop.js'

export interface AgentLoopDeps {
  /** LLM 流提供者（必需） */
  gateway: IStreamProvider
  /** 上下文管理器（必需） */
  contextManager: IContextManager
  /** 可观测性接口（可选） */
  observability?: IObservability
  /** 钩子注册表（可选） */
  hookRegistry?: IHookRegistry
  /** 日志接口（可选，默认 no-op） */
  logger?: ILogger
}

/**
 * 创建 AgentLoop 实例，注入所有依赖。
 *
 * 使用示例：
 * ```ts
 * const loop = createAgentLoop({
 *   gateway: new LLMGateway(),
 *   contextManager: new ContextManager(),
 *   observability: langfuseObserver,
 *   logger: new DebugLogger(sessionId),
 * })
 * ```
 */
export function createAgentLoop(deps: AgentLoopDeps): AgentLoop {
  return new AgentLoop(
    deps.gateway,
    deps.contextManager,
    deps.observability,
    deps.hookRegistry,
    deps.logger,
  )
}
