// ============================================================
// 共享文件工具 — 整合行尾处理 + Claude Code 多层匹配逻辑
// 供 FileEdit / MultiEdit / FileWrite 复用
// ============================================================

import fsSync from 'fs'
import fs from 'fs/promises'
import path from 'path'

// ---- 行尾类型与工具 ----

export type LineEndingType = 'CRLF' | 'LF'

/**
 * 检测内容中主流行尾风格。
 * CRLF 多数返回 'CRLF'，否则 'LF'。
 */
export function detectLineEndings(content: string): LineEndingType {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\r' && content[i + 1] === '\n') {
      crlf++
      i++ // skip the \n
    } else if (content[i] === '\n') {
      lf++
    }
  }
  return crlf > lf ? 'CRLF' : 'LF'
}

/**
 * 将内容转换到目标行尾风格。
 * LLM 输出总是 LF；写入 CRLF 文件时先归一化再转换，避免 \r\r\n。
 */
export function normalizeLineEndings(content: string, target: LineEndingType): string {
  if (target === 'LF') return content
  // 先统一为 LF，再转换到 CRLF
  return content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
}

/**
 * 写入文件，自动转换到目标行尾风格。
 */
export async function writeWithLineEndings(
  filePath: string,
  content: string,
  target: LineEndingType,
): Promise<void> {
  const adapted = normalizeLineEndings(content, target)
  await fs.writeFile(filePath, adapted, 'utf-8')
}

/**
 * 向上遍历目录树查找 .gitattributes 中的 eol=crlf 声明。
 * 找到返回 'CRLF'；.gitattributes 存在但无 eol 声明返回 null。
 */
export function getGitAttributesEol(dir: string): LineEndingType | null {
  let current = dir
  for (let i = 0; i < 20; i++) {
    const gaPath = path.join(current, '.gitattributes')
    try {
      if (fsSync.existsSync(gaPath)) {
        const ga = fsSync.readFileSync(gaPath, 'utf-8')
        if (/^[^#]*\beol\s*=\s*crlf\b/im.test(ga)) {
          return 'CRLF'
        }
        // .gitattributes 存在但无 eol 声明，停止查找
        return null
      }
    } catch {
      // 忽略读取错误
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/**
 * 新建文件时检测目标行尾：优先 .gitattributes，否则 LF。
 */
export function detectLineEndingsForNewFile(dir: string): LineEndingType {
  return getGitAttributesEol(dir) ?? 'LF'
}

// ---- 引号归一化（移植自 Claude Code） ----

const LEFT_SINGLE_CURLY_QUOTE = '\u2018'
const RIGHT_SINGLE_CURLY_QUOTE = '\u2019'
const LEFT_DOUBLE_CURLY_QUOTE = '\u201C'
const RIGHT_DOUBLE_CURLY_QUOTE = '\u201D'

/**
 * 弯引号 → 直引号。
 * LLM 输出可能包含弯引号，而文件内容使用直引号。
 */
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')
}

/**
 * 多层匹配回退：在文件内容中查找搜索字符串。
 *
 * 层级：
 * 1. 精确匹配
 * 2. 引号归一化（弯引号 → 直引号）
 * 3. 反消毒（处理 LLM 输出中被 sanitize 的 XML 标签）
 *
 * 返回匹配结果：actualString 为文件中的实际字符串，desanitizations
 * 供调用者对 new_string 做同步反消毒替换。未找到返回 null。
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): { actualString: string; desanitizations: Array<{ from: string; to: string }> } | null {
  // 层 1：精确匹配
  if (fileContent.includes(searchString)) {
    return { actualString: searchString, desanitizations: [] }
  }

  // 层 2：引号归一化
  // normalizeQuotes 是长度保持的（每个弯引号 → 1个直引号），所以 index 算术安全
  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)
  const searchIndex = normalizedFile.indexOf(normalizedSearch)
  if (searchIndex !== -1) {
    // 返回文件中的实际字符串（保留原始引号）
    return {
      actualString: fileContent.substring(searchIndex, searchIndex + searchString.length),
      desanitizations: [],
    }
  }

  // 层 3：反消毒
  const { result: desanitizedSearch, appliedReplacements } = desanitizeMatchString(searchString)
  if (desanitizedSearch !== searchString) {
    if (fileContent.includes(desanitizedSearch)) {
      return { actualString: desanitizedSearch, desanitizations: appliedReplacements }
    }
    // 反消毒 + 引号归一化
    const desanitizedNormalized = normalizeQuotes(desanitizedSearch)
    const idx = normalizedFile.indexOf(desanitizedNormalized)
    if (idx !== -1) {
      return {
        actualString: fileContent.substring(idx, idx + desanitizedSearch.length),
        desanitizations: appliedReplacements,
      }
    }
  }

  return null
}

// ---- 引号风格保留（移植自 Claude Code） ----

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) return true
  const prev = chars[index - 1]
  return (
    prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' ||
    prev === '(' || prev === '[' || prev === '{' ||
    prev === '\u2014' || prev === '\u2013' // em/en dash
  )
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(isOpeningContext(chars, i) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE)
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      const prev = i > 0 ? chars[i - 1] : undefined
      const next = i < chars.length - 1 ? chars[i + 1] : undefined
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev)
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next)
      // 缩写中的撇号（如 "don't"）
      if (prevIsLetter && nextIsLetter) {
        result.push(RIGHT_SINGLE_CURLY_QUOTE)
      } else {
        result.push(
          isOpeningContext(chars, i) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE,
        )
      }
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

/**
 * 当 old_string 通过引号归一化匹配到弯引号内容时，
 * 将相同弯引号风格应用到 new_string，保持文件排版一致性。
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) return newString

  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)

  if (!hasDoubleQuotes && !hasSingleQuotes) return newString

  let result = newString
  if (hasDoubleQuotes) result = applyCurlyDoubleQuotes(result)
  if (hasSingleQuotes) result = applyCurlySingleQuotes(result)
  return result
}

// ---- 反消毒（移植自 Claude Code） ----

/**
 * LLM 输出中可能被 sanitize 的 XML 标签映射。
 * 当精确匹配失败时，尝试将这些替代形式还原。
 */
const DESANITIZATIONS: Record<string, string> = {
  '<fnr>': '<function_results>',
  '<n>': '<name>',
  '</n>': '</name>',
  '<o>': '<output>',
  '</o>': '</output>',
  '<e>': '<error>',
  '</e>': '</error>',
  '<s>': '<system>',
  '</s>': '</system>',
  '<r>': '<result>',
  '</r>': '</result>',
}

/**
 * 对匹配字符串应用反消毒替换。
 * 返回归一化后的字符串和已应用的替换列表。
 */
export function desanitizeMatchString(matchString: string): {
  result: string
  appliedReplacements: Array<{ from: string; to: string }>
} {
  let result = matchString
  const appliedReplacements: Array<{ from: string; to: string }> = []

  for (const [from, to] of Object.entries(DESANITIZATIONS)) {
    const beforeReplace = result
    result = result.replaceAll(from, to)
    if (beforeReplace !== result) {
      appliedReplacements.push({ from, to })
    }
  }

  return { result, appliedReplacements }
}

/**
 * 将反消毒替换同步应用到 new_string。
 * 当 old_string 匹配到了反消毒内容时，new_string 中的同款标记也应还原。
 */
export function applyDesanitizationToNewString(
  newString: string,
  appliedReplacements: Array<{ from: string; to: string }>,
): string {
  let result = newString
  for (const { from, to } of appliedReplacements) {
    result = result.replaceAll(from, to)
  }
  return result
}

// ---- 计数工具 ----

/**
 * 统计搜索字符串的非重叠出现次数。
 */
export function countOccurrences(content: string, search: string): number {
  let count = 0
  let idx = 0
  while (true) {
    idx = content.indexOf(search, idx)
    if (idx === -1) break
    count++
    idx += search.length
  }
  return count
}
