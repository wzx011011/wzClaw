// ============================================================
// Tool Result Storage — 超大工具结果磁盘持久化
//
// 参考 Claude Code toolResultStorage.ts 的设计：
// 当工具结果超过阈值时，不直接截断（丢失信息），而是：
//   1. 将完整结果写入 ~/.wzxclaw/tool-results/{sessionId}/{toolUseId}.txt
//   2. 对话中替换为 <persisted-output> 引用 + 前 2KB 预览
//   3. 模型可通过 FileRead 工具读取完整内容
//
// 同时提供 ToolResultReplacementState（Prompt Cache 决策冻结）：
//   - 一旦某个 tool_use_id 的"替换 or 不替换"决策做出，全 session 冻结不变
//   - 保证发给 API 的 prompt 前缀 byte-identical，维持 Anthropic prompt cache 命中
//   - 仅对 Anthropic provider 启用
//
// 图片类型豁免，直接通过。
// ============================================================

import * as fs from 'fs/promises'
import * as path from 'path'
import { getToolResultsDir } from '../paths'
import { DEFAULT_RUNTIME_CONFIG } from '../agent/runtime-config'

/** 持久化时写入磁盘的预览大小（字节） */
const PREVIEW_SIZE = 2_000

/** 持久化引用消息的模板 */
function buildPersistedOutputMessage(filePath: string, sizeChars: number, preview: string): string {
  return `<persisted-output>\nTool output too large (${sizeChars} chars). Full output saved to:\n${filePath}\n\nPreview (first ${PREVIEW_SIZE} chars):\n${preview}\n\nUse the FileRead tool to access the complete output.\n</persisted-output>`
}

/**
 * 如果工具结果超过阈值，将完整内容写入磁盘，并返回替换字符串。
 * 否则返回 null（调用方使用原始内容）。
 *
 * @param toolName   - 工具名称（用于文件扩展名选择）
 * @param toolUseId  - 工具调用 ID（用于文件名，确保唯一）
 * @param content    - 工具返回的完整输出
 * @param sessionId  - 当前 session ID（用于目录隔离）
 * @param threshold  - 触发持久化的字符数阈值
 * @returns 替换字符串（<persisted-output>...），或 null（内容在阈值内）
 */
export async function maybePersistLargeToolResult(
  toolName: string,
  toolUseId: string,
  content: string,
  sessionId: string,
  threshold: number = DEFAULT_RUNTIME_CONFIG.toolResultPersistThresholdChars,
): Promise<string | null> {
  if (content.length <= threshold) return null

  const dir = getToolResultsDir(sessionId)
  await fs.mkdir(dir, { recursive: true })

  // 文件名：{toolUseId}.txt（toolUseId 已是唯一标识符）
  const ext = 'txt'
  const fileName = `${sanitizeForFilename(toolUseId)}.${ext}`
  const filePath = path.join(dir, fileName)

  await fs.writeFile(filePath, content, 'utf-8')

  const preview = content.slice(0, PREVIEW_SIZE)
  return buildPersistedOutputMessage(filePath, content.length, preview)
}

/** 清理 toolUseId 中可能出现的文件名非法字符 */
function sanitizeForFilename(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 200)
}

/**
 * 清理指定 session 的所有持久化工具结果文件。
 * 用于 session 结束后的资源回收。
 */
export async function cleanupToolResults(sessionId: string): Promise<void> {
  const dir = getToolResultsDir(sessionId)
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // 目录不存在时静默忽略
  }
}

// ============================================================
// Prompt Cache 决策冻结（Anthropic 专属）
// ============================================================

/**
 * 工具结果替换决策的冻结状态。
 * - key: tool_use_id
 * - value: 替换字符串（<persisted-output>...），或 null（不替换，保留原始内容）
 *
 * 一旦某个 tool_use_id 的决策记录后，不再改变，确保 prompt 前缀 byte-identical。
 */
export class ToolResultReplacementState {
  private decisions = new Map<string, string | null>()

  /**
   * 检查是否有已冻结的决策。
   * 返回：
   *   - string: 此前决定替换，使用这个替换字符串
   *   - null: 此前决定不替换，继续使用原始内容
   *   - undefined: 尚无决策，调用方需要自行判断
   */
  getCachedDecision(toolUseId: string): string | null | undefined {
    if (!this.decisions.has(toolUseId)) return undefined
    return this.decisions.get(toolUseId)!
  }

  /**
   * 记录决策（幂等：如果已有决策，不覆盖）。
   */
  recordDecision(toolUseId: string, replacement: string | null): void {
    if (!this.decisions.has(toolUseId)) {
      this.decisions.set(toolUseId, replacement)
    }
  }

  /** 清除所有决策（session 重置时调用） */
  reset(): void {
    this.decisions.clear()
  }

  /** 当前已记录的决策数量 */
  get size(): number {
    return this.decisions.size
  }
}

