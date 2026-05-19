// ============================================================
// Glob 工具 — 按模式匹配查找文件
// 支持 **/*.ts 等标准 glob 模式
// ============================================================

import { readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { HandTool } from '../src/tool-executor.js'
import { assertPathInWorkspace } from '../src/path-guard.js'

const DEFAULT_MAX_RESULTS = 500

export class GlobTool implements HandTool {
  readonly name = 'Glob'
  readonly description = '按 glob 模式查找文件，返回匹配的文件路径列表'
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式（如 **/*.ts）' },
      path: { type: 'string', description: '搜索根目录' },
      maxResults: { type: 'number', description: `最大结果数（默认 ${DEFAULT_MAX_RESULTS}）` },
    },
    required: ['pattern', 'path'],
  }
  readonly isReadOnly = true

  async execute(
    input: Record<string, unknown>,
    context: { workingDirectory: string; projectRoots: string[] },
  ): Promise<{ output: string; isError: boolean }> {
    const pattern = input.pattern
    if (typeof pattern !== 'string' || pattern.length === 0) {
      return { output: '缺少 pattern 参数', isError: true }
    }
    const searchPath = input.path
    if (typeof searchPath !== 'string' || searchPath.length === 0) {
      return { output: '缺少 path 参数', isError: true }
    }

    // 路径白名单校验
    const violation = assertPathInWorkspace(searchPath, context)
    if (violation) return violation

    try {
      const maxResults = typeof input.maxResults === 'number' ? input.maxResults : DEFAULT_MAX_RESULTS
      const files: string[] = []
      const regex = this.globToRegex(pattern)
      const pathSepRegex = /[/\\]/ // 匹配 / 和 \

      await this.walk(searchPath, regex, pathSepRegex, files, maxResults)

      if (files.length === 0) {
        return { output: 'No files matched', isError: false }
      }
      return { output: JSON.stringify(files), isError: false }
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), isError: true }
    }
  }

  private async walk(
    dirPath: string,
    regex: RegExp,
    pathSepRegex: RegExp,
    files: string[],
    maxResults: number,
  ): Promise<void> {
    if (files.length >= maxResults) return
    let dirents
    try {
      dirents = await readdir(dirPath, { withFileTypes: true })
    } catch { return }

    for (const dirent of dirents) {
      if (files.length >= maxResults) return
      if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue

      const fullPath = join(dirPath, dirent.name)
      if (dirent.isDirectory()) {
        await this.walk(fullPath, regex, pathSepRegex, files, maxResults)
      } else {
        // 标准化路径分隔符为 / 以匹配 glob 模式
        const normalized = fullPath.replace(/\\/g, '/')
        if (regex.test(normalized)) {
          files.push(fullPath)
        }
        regex.lastIndex = 0
      }
    }
  }

  private globToRegex(pattern: string): RegExp {
    // 防止 ReDoS：限制模式长度和连续星号数量
    if (pattern.length > 256) throw new Error('Glob pattern too long (max 256 chars)')
    if (/(?:\*){4,}|(?:\?){4,}/.test(pattern)) throw new Error('Glob pattern too complex')

    // ** -> 匹配任意路径段（含 /）
    // * -> 匹配任意字符（不含 /）
    // ? -> 匹配单字符
    let regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*')
    // 带路径分隔符的模式匹配完整路径，否则只匹配文件名
    return new RegExp(pattern.includes('/') ? regexStr : `^${regexStr}$`)
  }
}
