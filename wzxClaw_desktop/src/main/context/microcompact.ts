// ============================================================
// Time-Based Microcompact — 清理旧工具结果
// 参考 Claude Code microCompact.ts，provider-agnostic，无 API 调用
//
// 当距上次 assistant 消息超过阈值（默认 60 分钟）时，
// 清理旧的 compactable 工具结果的 content，减少 token 占用。
// 消息结构保持不变（role、toolCallId 等），只替换 content 字段。
// ============================================================

import type { Message, AssistantMessage, ToolResultMessage } from '../../shared/types'

/** 清理后替换的占位符文本 */
export const TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]'

/**
 * 可压缩的工具名称集合。
 * 这些工具的输出通常较大（文件内容、命令输出、搜索结果），
 * 清理旧结果对对话质量影响最小。
 */
const COMPACTABLE_TOOLS = new Set<string>([
  'FileRead',
  'FileWrite',
  'FileEdit',
  'Bash',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'SemanticSearch',
])

export interface MicrocompactConfig {
  /** 距上次 assistant 消息超过此分钟数触发（默认 60） */
  gapMinutes: number
  /** 保留最近 N 个 compactable 工具结果（默认 5） */
  keepRecent: number
}

const DEFAULT_CONFIG: MicrocompactConfig = {
  gapMinutes: 60,
  keepRecent: 5,
}

export interface MicrocompactResult {
  /** 是否执行了清理 */
  didCompact: boolean
  /** 清理了多少个工具结果 */
  clearedCount: number
  /** 估算节省的字符数 */
  charsSaved: number
  /** 距上次 assistant 消息的分钟数 */
  gapMinutes: number
}

/**
 * 评估是否应该触发 time-based microcompact。
 * 返回 gap 分钟数，或 null（不触发）。
 */
export function evaluateTimeBasedTrigger(
  messages: Message[],
  config: MicrocompactConfig = DEFAULT_CONFIG,
): number | null {
  // 找最后一条 assistant 消息
  let lastAssistantTs: number | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantTs = messages[i].timestamp
      break
    }
  }
  if (lastAssistantTs === null) return null

  const gapMs = Date.now() - lastAssistantTs
  const gapMin = gapMs / 60_000

  if (!Number.isFinite(gapMin) || gapMin < config.gapMinutes) return null
  return gapMin
}

/**
 * 收集消息中所有 compactable 工具的 toolCallId（按遇到顺序）。
 * 从 assistant 消息的 toolCalls 字段收集，而非 contentBlocks。
 */
function collectCompactableToolIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const asst = msg as AssistantMessage
    if (!asst.toolCalls) continue
    for (const tc of asst.toolCalls) {
      if (COMPACTABLE_TOOLS.has(tc.name)) {
        ids.push(tc.id)
      }
    }
  }
  return ids
}

/**
 * 执行 time-based microcompact。
 * 返回修改后的消息数组（浅拷贝，不修改原数组）。
 *
 * 逻辑：
 * 1. 收集所有 compactable 工具的 toolCallId
 * 2. 保留最近 keepRecent 个，其余标记为 clearSet
 * 3. 将 clearSet 中的 tool_result 消息的 content 替换为占位符
 */
export function maybeTimeBasedMicrocompact(
  messages: Message[],
  config: MicrocompactConfig = DEFAULT_CONFIG,
): { messages: Message[]; result: MicrocompactResult } {
  const noop = {
    messages,
    result: { didCompact: false, clearedCount: 0, charsSaved: 0, gapMinutes: 0 } as MicrocompactResult,
  }

  const gapMin = evaluateTimeBasedTrigger(messages, config)
  if (gapMin === null) return noop

  const compactableIds = collectCompactableToolIds(messages)
  if (compactableIds.length === 0) return noop

  // 至少保留 1 个
  const keepRecent = Math.max(1, config.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))

  if (clearSet.size === 0) return noop

  // 替换 tool_result 消息的 content
  let clearedCount = 0
  let charsSaved = 0
  const result: Message[] = messages.map(msg => {
    if (msg.role !== 'tool_result') return msg
    const tr = msg as ToolResultMessage
    if (!clearSet.has(tr.toolCallId)) return msg
    if (tr.content === TOOL_RESULT_CLEARED_MESSAGE) return msg // 已清理过

    charsSaved += tr.content.length
    clearedCount++
    return { ...tr, content: TOOL_RESULT_CLEARED_MESSAGE }
  })

  if (clearedCount === 0) return noop

  return {
    messages: result,
    result: { didCompact: true, clearedCount, charsSaved, gapMinutes: gapMin },
  }
}
