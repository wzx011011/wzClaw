// ============================================================
// Compact File Restoration — 压缩后恢复最近引用的文件内容
// 参考 Claude Code autoCompact 的 post-compact file restoration
//
// 自动压缩会丢弃历史消息，导致之前读过的文件上下文丢失。
// 此模块在压缩后扫描被摘要化的消息，提取最近引用的文件路径，
// 读取文件内容并注入到压缩后的对话中，避免 agent 重复读文件。
// ============================================================

import fs from 'fs'
import path from 'path'
import { countTokens } from './token-counter.js'
import type { Message, ToolCall } from '../types.js'

/** 文件恢复的预算 tokens（参考 Claude Code 的 50K budget） */
const FILE_RESTORE_BUDGET_TOKENS = 50_000

/** 单个文件最大注入 tokens */
const MAX_FILE_TOKENS = 15_000

/** 最多恢复的文件数量 */
const MAX_FILES_TO_RESTORE = 10

/** 可提取文件路径的工具名 → 输入字段 */
const FILE_TOOL_INPUT_FIELDS: Record<string, string> = {
  FileRead: 'path',
  FileWrite: 'path',
  FileEdit: 'path',
  Bash: 'command',
  Grep: 'path',
  Glob: 'path',
}

/**
 * 从 toolCalls 中提取文件路径。
 * 返回有序的文件路径列表（按出现顺序，去重但保留最后出现位置）。
 */
export function extractFilePathsFromToolCalls(toolCalls: ToolCall[]): string[] {
  const paths: string[] = []
  for (const tc of toolCalls) {
    const field = FILE_TOOL_INPUT_FIELDS[tc.name]
    if (!field) continue
    const value = tc.input[field]
    if (typeof value !== 'string') continue

    if (tc.name === 'Bash') {
      // 从 Bash 命令中提取文件路径（cat xxx, head xxx, tail xxx 等）
      const filePatterns = [
        // 带引号的路径（cat "path with spaces"）
        /(?:cat|head|tail|less|more|type)\s+["']([^"']+)["']/g,
        // 不带引号的路径（cat /path/to/file 或 cat file.ext）
        /(?:cat|head|tail|less|more|type)\s+([^\s"']+)/g,
      ]
      for (const pattern of filePatterns) {
        let match
        while ((match = pattern.exec(value)) !== null) {
          const p = match[1]
          // 跳过明显的非文件路径（flags, 短字符串等）
          if (p.length > 3 && !p.startsWith('-')) {
            paths.push(p)
          }
        }
      }
    } else {
      paths.push(value)
    }
  }
  return paths
}

/**
 * 从被摘要化的消息中提取所有引用的文件路径。
 * 返回按最近使用排序的去重路径列表。
 */
export function extractRecentFilePaths(
  summarizedMessages: Message[],
  maxFiles: number = MAX_FILES_TO_RESTORE
): string[] {
  // 从后往前扫描，收集文件路径（最近的优先）
  const seen = new Set<string>()
  const ordered: string[] = []

  for (let i = summarizedMessages.length - 1; i >= 0; i--) {
    const msg = summarizedMessages[i]
    if (msg.role !== 'assistant') continue
    if (!msg.toolCalls || msg.toolCalls.length === 0) continue

    const paths = extractFilePathsFromToolCalls(msg.toolCalls)
    for (const p of paths) {
      const normalized = p.replace(/\\/g, '/')
      if (!seen.has(normalized)) {
        seen.add(normalized)
        ordered.push(p)
      }
    }

    if (ordered.length >= maxFiles) break
  }

  return ordered
}

/**
 * 异步读取文件内容，截断到 maxTokens。
 * 如果文件不存在或无法读取，跳过。
 */
export async function readFileContent(filePath: string, maxTokens: number): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(filePath).catch(() => null)
    if (!stat) return null
    if (stat.isDirectory()) return null
    if (stat.size > 1024 * 1024) return null // 跳过 > 1MB 的文件

    const content = await fs.promises.readFile(filePath, 'utf-8')
    const tokens = countTokens(content)
    if (tokens > maxTokens) {
      // 截断到 maxTokens 对应的字符数（粗估 4 chars/token）
      const maxChars = maxTokens * 4
      return content.substring(0, maxChars) + '\n[... file truncated]'
    }
    return content
  } catch {
    return null
  }
}

export interface RestoredFile {
  path: string
  content: string
  tokens: number
}

/**
 * 异步恢复压缩后引用的文件内容。
 * 按最近使用排序，在 budget 范围内读取文件内容。
 */
export async function restoreFiles(
  summarizedMessages: Message[],
  workingDirectory?: string,
  budgetTokens: number = FILE_RESTORE_BUDGET_TOKENS
): Promise<RestoredFile[]> {
  const filePaths = extractRecentFilePaths(summarizedMessages)
  if (filePaths.length === 0) return []

  const restored: RestoredFile[] = []
  let usedBudget = 0

  for (const rawPath of filePaths) {
    if (usedBudget >= budgetTokens) break

    // 解析相对路径
    let resolvedPath = rawPath
    if (!path.isAbsolute(rawPath) && workingDirectory) {
      resolvedPath = path.resolve(workingDirectory, rawPath)
    }

    const remainingBudget = budgetTokens - usedBudget
    const fileMaxTokens = Math.min(MAX_FILE_TOKENS, remainingBudget)

    const content = await readFileContent(resolvedPath, fileMaxTokens)
    if (content === null) continue

    const tokens = countTokens(content)
    restored.push({ path: rawPath, content, tokens })
    usedBudget += tokens
  }

  return restored
}

/**
 * 将恢复的文件内容格式化为注入到对话中的 system-reminder 消息。
 */
export function formatRestoredFilesMessage(files: RestoredFile[]): string {
  if (files.length === 0) return ''

  const lines: string[] = [
    'Files recently referenced before context compaction (content restored):',
  ]

  for (const f of files) {
    const ext = path.extname(f.path).slice(1) || 'text'
    lines.push('')
    lines.push(`### ${f.path}`)
    lines.push('```' + ext)
    lines.push(f.content)
    lines.push('```')
  }

  lines.push('')
  lines.push('These files were read or modified before compaction. Use this content to continue working without re-reading.')

  return lines.join('\n')
}
