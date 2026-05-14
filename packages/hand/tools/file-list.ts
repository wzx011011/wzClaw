// ============================================================
// FileList 工具 — 列出 NAS 卷上的目录内容
// 支持：递归列出、glob 模式过滤、文件元数据
// ============================================================

import { readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { HandTool } from '../src/tool-executor.js'

/** 目录条目结构 */
interface FileEntry {
  /** 文件/目录名 */
  name: string
  /** 完整路径 */
  path: string
  /** 文件大小（字节） */
  size: number
  /** 是否为目录 */
  isDir: boolean
  /** 最后修改时间（ISO 字符串） */
  modified: string
}

/**
 * FileListTool — 列出目录内容
 *
 * 功能:
 * - 列出指定目录下所有文件和子目录
 * - 返回 JSON 数组 [{name, path, size, isDir, modified}]
 * - recursive=true 递归子目录
 * - pattern 支持 glob 模式过滤文件名
 * - 不存在的目录返回错误
 */
export class FileListTool implements HandTool {
  readonly name = 'FileList'
  readonly description = '列出目录内容，返回文件元数据'
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径' },
      recursive: { type: 'boolean', description: '是否递归列出子目录' },
      pattern: { type: 'string', description: '文件名 glob 模式（可选）' },
    },
    required: ['path'],
  }
  readonly isReadOnly = true

  async execute(
    input: Record<string, unknown>,
    _context: { workingDirectory: string; projectRoots: string[] },
  ): Promise<{ output: string; isError: boolean }> {
    // 校验必需参数
    const dirPath = input.path
    if (typeof dirPath !== 'string' || dirPath.length === 0) {
      return { output: '缺少 path 参数', isError: true }
    }

    try {
      const recursive = input.recursive === true
      const pattern = typeof input.pattern === 'string' ? input.pattern : null

      const entries = await this.listDirectory(dirPath, recursive, pattern)
      return { output: JSON.stringify(entries), isError: false }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: message, isError: true }
    }
  }

  /**
   * 递归列出目录内容
   *
   * @param dirPath - 目录路径
   * @param recursive - 是否递归
   * @param pattern - glob 模式（仅匹配文件名）
   * @returns 文件条目数组
   */
  private async listDirectory(
    dirPath: string,
    recursive: boolean,
    pattern: string | null,
  ): Promise<FileEntry[]> {
    // 读取目录内容
    const dirents = await readdir(dirPath, { withFileTypes: true })
    const result: FileEntry[] = []

    for (const dirent of dirents) {
      const fullPath = join(dirPath, dirent.name)

      if (dirent.isDirectory()) {
        // 目录条目：不受 pattern 过滤（pattern 只匹配文件名）
        result.push({
          name: dirent.name,
          path: fullPath,
          size: 0,
          isDir: true,
          modified: '', // 目录不获取 mtime，避免额外 stat
        })

        // 递归列出子目录内容
        if (recursive) {
          const subEntries = await this.listDirectory(fullPath, recursive, pattern)
          result.push(...subEntries)
        }
      } else {
        // 文件条目：应用 pattern 过滤
        if (pattern && !this.matchGlob(dirent.name, pattern)) {
          continue
        }

        // 获取文件元数据
        const fileStat = await stat(fullPath)
        result.push({
          name: dirent.name,
          path: fullPath,
          size: fileStat.size,
          isDir: false,
          modified: fileStat.mtime.toISOString(),
        })
      }
    }

    return result
  }

  /**
   * 最小 glob 匹配实现
   *
   * 仅支持 * 通配符（匹配任意字符序列）
   * 例如: "*.ts" 匹配所有 .ts 文件
   *
   * @param name - 文件名
   * @param pattern - glob 模式
   * @returns 是否匹配
   */
  private matchGlob(name: string, pattern: string): boolean {
    // 将 glob 模式转换为正则表达式
    // * 转为 .*, ? 转为 ., 其余转义
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 转义特殊字符
      .replace(/\*/g, '.*')                   // * 匹配任意字符序列
      .replace(/\?/g, '.')                    // ? 匹配单个字符
    const regex = new RegExp(`^${regexStr}$`)
    return regex.test(name)
  }
}
