// ============================================================
// Grep 工具 — 在文件中搜索文本/正则模式
// 支持正则、文件类型过滤、行数上下文、大小写忽略
// ============================================================

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'
import type { HandTool } from '../src/tool-executor.js'

const DEFAULT_MAX_RESULTS = 200

const EXTENSION_MAP: Record<string, string[]> = {
  ts: ['.ts', '.tsx'],
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  py: ['.py'],
  rs: ['.rs'],
  go: ['.go'],
  java: ['.java'],
  md: ['.md', '.mdx'],
  json: ['.json'],
  yaml: ['.yaml', '.yml'],
  html: ['.html', '.htm'],
  css: ['.css', '.scss', '.less'],
}

interface GrepMatch {
  file: string
  line: number
  text: string
}

export class GrepTool implements HandTool {
  readonly name = 'Grep'
  readonly description = '在文件中搜索文本或正则模式，返回匹配行'
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则表达式）' },
      path: { type: 'string', description: '搜索目录路径' },
      filePattern: { type: 'string', description: '文件名 glob（如 *.ts）' },
      type: { type: 'string', description: '文件类型（ts/js/py 等）' },
      ignoreCase: { type: 'boolean', description: '忽略大小写' },
      maxResults: { type: 'number', description: `最大结果数（默认 ${DEFAULT_MAX_RESULTS}）` },
    },
    required: ['pattern', 'path'],
  }
  readonly isReadOnly = true

  async execute(
    input: Record<string, unknown>,
    _context: { workingDirectory: string; projectRoots: string[] },
  ): Promise<{ output: string; isError: boolean }> {
    const pattern = input.pattern
    if (typeof pattern !== 'string' || pattern.length === 0) {
      return { output: '缺少 pattern 参数', isError: true }
    }
    const searchPath = input.path
    if (typeof searchPath !== 'string' || searchPath.length === 0) {
      return { output: '缺少 path 参数', isError: true }
    }

    try {
      const ignoreCase = input.ignoreCase === true
      const maxResults = typeof input.maxResults === 'number' ? input.maxResults : DEFAULT_MAX_RESULTS
      const filePattern = typeof input.filePattern === 'string' ? input.filePattern : null
      const typeExt = typeof input.type === 'string' ? EXTENSION_MAP[input.type] ?? [`.${input.type}`] : null

      let regex: RegExp
      try {
        regex = new RegExp(pattern, ignoreCase ? 'i' : '')
      } catch {
        return { output: `Invalid regex pattern: ${pattern}`, isError: true }
      }
      const matches: GrepMatch[] = []

      await this.searchDir(searchPath, regex, filePattern, typeExt, matches, maxResults)

      if (matches.length === 0) {
        return { output: 'No matches found', isError: false }
      }

      const lines = matches.map(m => `${m.file}:${m.line}: ${m.text}`)
      return { output: lines.join('\n'), isError: false }
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), isError: true }
    }
  }

  private async searchDir(
    dirPath: string,
    regex: RegExp,
    filePattern: string | null,
    typeExt: string[] | null,
    matches: GrepMatch[],
    maxResults: number,
  ): Promise<void> {
    if (matches.length >= maxResults) return

    const dirents = await readdir(dirPath, { withFileTypes: true })
    for (const dirent of dirents) {
      if (matches.length >= maxResults) return
      const fullPath = join(dirPath, dirent.name)

      // 跳过隐藏和 node_modules
      if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue

      if (dirent.isDirectory()) {
        await this.searchDir(fullPath, regex, filePattern, typeExt, matches, maxResults)
      } else {
        // 文件类型过滤
        if (typeExt && !typeExt.includes(extname(fullPath))) continue
        // 文件名 glob 过滤
        if (filePattern && !this.matchGlob(dirent.name, filePattern)) continue
        // 跳过二进制/超大文件
        try {
          const s = await stat(fullPath)
          if (s.size > 1024 * 1024) continue // >1MB
        } catch { continue }

        await this.searchFile(fullPath, regex, matches, maxResults)
      }
    }
  }

  private async searchFile(
    filePath: string,
    regex: RegExp,
    matches: GrepMatch[],
    maxResults: number,
  ): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (regex.test(lines[i])) {
          matches.push({ file: filePath, line: i + 1, text: lines[i] })
        }
        // 重置 lastIndex（非 g flag 不需要，但防御性）
        regex.lastIndex = 0
      }
    } catch {
      // 跳过不可读文件（二进制、权限等）
    }
  }

  private matchGlob(name: string, pattern: string): boolean {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    return new RegExp(`^${regexStr}$`).test(name)
  }
}
