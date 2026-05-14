// ============================================================
// Hand 协议编解码
// 消息构造（出站）和解析（入站）函数
// 出站消息序列化为 JSON 字符串，入站消息反序列化并类型化
// ============================================================

import type { IncomingMessage, IncomingExecuteMessage, HandToolDefinition } from './types.js'

/**
 * 构造 hand:register 注册消息
 *
 * @param handId - Hand 唯一标识符
 * @param capabilities - Hand 支持的工具名列表
 * @param definitions - 工具定义数组
 * @returns JSON 字符串
 */
export function createRegisterMessage(
  handId: string,
  capabilities: string[],
  definitions: HandToolDefinition[],
): string {
  return JSON.stringify({
    event: 'hand:register',
    data: {
      id: handId,
      capabilities,
      definitions,
    },
  })
}

/**
 * 构造 hand:result 工具执行结果消息
 *
 * @param callId - 调用唯一标识符
 * @param output - 执行输出
 * @param isError - 是否为错误结果
 * @returns JSON 字符串
 */
export function createResultMessage(
  callId: string,
  output: string,
  isError: boolean,
): string {
  return JSON.stringify({
    event: 'hand:result',
    data: {
      callId,
      output,
      isError,
    },
  })
}

/**
 * 构造 hand:heartbeat 心跳消息
 *
 * @returns JSON 字符串（无 data 字段）
 */
export function createHeartbeatMessage(): string {
  return JSON.stringify({
    event: 'hand:heartbeat',
  })
}

/**
 * 解析入站消息（从 agent-server 收到的原始字符串）
 *
 * 严格验证消息格式：
 * - 必须是合法 JSON
 * - 必须包含 event 字符串字段
 * - 对于 hand:execute，提取 callId/name/input/context
 *
 * @param raw - 原始 JSON 字符串
 * @returns 类型化的 IncomingMessage 或 null（无效输入）
 */
export function parseIncomingMessage(raw: string): IncomingMessage | null {
  // 空字符串直接返回 null
  if (!raw) {
    return null
  }

  // 解析 JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  // 必须是对象
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }

  const obj = parsed as Record<string, unknown>

  // 必须有 event 字符串字段
  if (typeof obj.event !== 'string') {
    return null
  }

  // hand:execute — 提取工具执行参数
  if (obj.event === 'hand:execute') {
    const data = obj.data as Record<string, unknown> | undefined
    if (!data || typeof data !== 'object') {
      return { event: 'hand:execute', data: { callId: '', name: '', input: {}, context: { workingDirectory: '', projectRoots: [] } } }
    }
    return {
      event: 'hand:execute',
      data: {
        callId: String(data.callId ?? ''),
        name: String(data.name ?? ''),
        input: (data.input as Record<string, unknown>) ?? {},
        context: (data.context as { workingDirectory: string; projectRoots: string[] }) ?? { workingDirectory: '', projectRoots: [] },
      },
    } satisfies IncomingExecuteMessage
  }

  // hand:heartbeat_ack
  if (obj.event === 'hand:heartbeat_ack') {
    return { event: 'hand:heartbeat_ack' }
  }

  // 其他未知消息
  return {
    event: obj.event,
    data: obj.data as unknown,
  }
}
