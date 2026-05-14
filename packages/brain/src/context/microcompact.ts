// ============================================================
// Enhanced Microcompact — Claude Code 风格的多策略微压缩
// 完整迁移自 Claude Code src/services/compact/microCompact.ts
//
// 三层策略：
//   1. Time-based: 距上次 assistant 消息超过阈值时清理旧工具结果
//   2. Token-pressure: 上下文接近阈值时按压力清理
//   3. File-tool aware: 文件工具结果优先保留（避免重复读文件）
//
// 所有策略都无 API 调用，纯客户端清理。
// ============================================================

import type { Message, AssistantMessage, ToolResultMessage } from '../types.js'

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

/**
 * 文件工具名称集合。这些工具的结果在 token-pressure 模式下
 * 优先保留，因为丢失后需要重新读文件（额外 API round-trip）。
 */
const FILE_TOOLS = new Set<string>([
  'FileRead',
  'FileWrite',
  'FileEdit',
])

export interface MicrocompactConfig {
  /** 距上次 assistant 消息超过此分钟数触发（默认 60） */
  gapMinutes: number
  /** 保留最近 N 个 compactable 工具结果（默认 5） */
  keepRecent: number
  /** Token pressure 阈值：当 token 使用率超过此比例时触发（默认 0.80） */
  tokenPressureThreshold: number
}

const DEFAULT_CONFIG: MicrocompactConfig = {
  gapMinutes: 60,
  keepRecent: 5,
  tokenPressureThreshold: 0.80,
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
  /** 触发策略 */
  trigger: 'time' | 'token_pressure' | 'none'
}

/**
 * 评估是否应该触发 time-based microcompact。
 * 返回 gap 分钟数，或 null（不触发）。
 */
export function evaluateTimeBasedTrigger(
  messages: Message[],
  config: MicrocompactConfig = DEFAULT_CONFIG,
): number | null {
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
 * 评估是否应该触发 token-pressure microcompact。
 * 当估算的 token 使用率超过阈值时触发。
 */
export function evaluateTokenPressureTrigger(
  messages: Message[],
  contextWindowTokens: number,
  currentTokenCount: number,
  config: MicrocompactConfig = DEFAULT_CONFIG,
): boolean {
  if (contextWindowTokens <= 0) return false
  const usageRatio = currentTokenCount / contextWindowTokens
  return usageRatio >= config.tokenPressureThreshold
}

/**
 * 收集消息中所有 compactable 工具的 toolCallId（按遇到顺序）。
 * 从 assistant 消息的 toolCalls 字段收集。
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
 * 收集文件工具的 toolCallId（优先保留）。
 */
function collectFileToolIds(messages: Message[]): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const asst = msg as AssistantMessage
    if (!asst.toolCalls) continue
    for (const tc of asst.toolCalls) {
      if (FILE_TOOLS.has(tc.name)) {
        ids.add(tc.id)
      }
    }
  }
  return ids
}

/**
 * 执行清理：将 clearSet 中的 tool_result 消息的 content 替换为占位符。
 * 文件工具结果优先保留（从 clearSet 中排除）。
 */
function executeClear(
  messages: Message[],
  compactableIds: string[],
  keepRecent: number,
  fileToolIds: Set<string>,
): { messages: Message[]; clearedCount: number; charsSaved: number } {
  const keepSet = new Set(compactableIds.slice(-keepRecent))

  // 文件工具结果额外保护：即使在 clearSet 中也不清理
  const clearCandidates = compactableIds.filter(id => !keepSet.has(id))
  const clearSet = new Set(clearCandidates.filter(id => !fileToolIds.has(id)))

  // 如果非文件工具清理后没有节省，再考虑清理文件工具
  if (clearSet.size === 0) {
    clearCandidates.forEach(id => clearSet.add(id))
  }

  if (clearSet.size === 0) {
    return { messages, clearedCount: 0, charsSaved: 0 }
  }

  let clearedCount = 0
  let charsSaved = 0
  const result: Message[] = messages.map(msg => {
    if (msg.role !== 'tool_result') return msg
    const tr = msg as ToolResultMessage
    if (!clearSet.has(tr.toolCallId)) return msg
    if (tr.content === TOOL_RESULT_CLEARED_MESSAGE) return msg

    charsSaved += tr.content.length
    clearedCount++
    return { ...tr, content: TOOL_RESULT_CLEARED_MESSAGE }
  })

  return { messages: result, clearedCount, charsSaved }
}

/**
 * 执行 time-based microcompact。
 * 返回修改后的消息数组（浅拷贝，不修改原数组）。
 */
export function maybeTimeBasedMicrocompact(
  messages: Message[],
  config: MicrocompactConfig = DEFAULT_CONFIG,
): { messages: Message[]; result: MicrocompactResult } {
  const noop = {
    messages,
    result: { didCompact: false, clearedCount: 0, charsSaved: 0, gapMinutes: 0, trigger: 'none' as const },
  }

  const gapMin = evaluateTimeBasedTrigger(messages, config)
  if (gapMin === null) return noop

  const compactableIds = collectCompactableToolIds(messages)
  if (compactableIds.length === 0) return noop

  const keepRecent = Math.max(1, config.keepRecent)
  const fileToolIds = collectFileToolIds(messages)
  const { messages: result, clearedCount, charsSaved } = executeClear(messages, compactableIds, keepRecent, fileToolIds)

  if (clearedCount === 0) return noop

  return {
    messages: result,
    result: { didCompact: true, clearedCount, charsSaved, gapMinutes: gapMin, trigger: 'time' },
  }
}

/**
 * 执行 token-pressure microcompact。
 * 当上下文接近阈值时，更积极地清理旧工具结果。
 */
export function maybeTokenPressureMicrocompact(
  messages: Message[],
  contextWindowTokens: number,
  currentTokenCount: number,
  config: MicrocompactConfig = DEFAULT_CONFIG,
): { messages: Message[]; result: MicrocompactResult } {
  const noop = {
    messages,
    result: { didCompact: false, clearedCount: 0, charsSaved: 0, gapMinutes: 0, trigger: 'none' as const },
  }

  if (!evaluateTokenPressureTrigger(messages, contextWindowTokens, currentTokenCount, config)) {
    return noop
  }

  const compactableIds = collectCompactableToolIds(messages)
  if (compactableIds.length === 0) return noop

  // Token pressure 模式更激进：只保留最近 3 个
  const keepRecent = Math.min(3, config.keepRecent)
  const fileToolIds = collectFileToolIds(messages)
  const { messages: result, clearedCount, charsSaved } = executeClear(messages, compactableIds, keepRecent, fileToolIds)

  if (clearedCount === 0) return noop

  return {
    messages: result,
    result: { didCompact: true, clearedCount, charsSaved, gapMinutes: 0, trigger: 'token_pressure' },
  }
}

/**
 * 重置 microcompact 状态（在压缩后调用）。
 * 目前是 no-op，预留用于未来状态追踪。
 */
export function resetMicrocompactState(): void {
  // No-op for now — reserved for future state tracking
}
