// ============================================================
// paste-cache.ts — SHA-256 内容寻址的大段粘贴文本缓存
// 存储路径：~/.wzxclaw/paste-cache/{sha256}.txt
// ============================================================

import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import { getPasteCacheDir } from '../paths'

/**
 * 将大段文本存入 paste-cache，幂等操作。
 * @returns 内容的 SHA-256 哈希值（64 位 hex），可用于后续引用
 */
export async function storePastedText(content: string): Promise<string> {
  const hash = crypto.createHash('sha256').update(content, 'utf-8').digest('hex')
  const filePath = path.join(getPasteCacheDir(), `${hash}.txt`)
  try {
    // 文件已存在时直接返回（幂等）
    await fs.access(filePath)
  } catch {
    // 文件不存在，写入
    await fs.writeFile(filePath, content, 'utf-8')
  }
  return hash
}

/**
 * 从 paste-cache 读取文本内容。
 * @returns 文本内容，文件不存在时返回 null
 */
export async function loadPastedText(hash: string): Promise<string | null> {
  // 验证 hash 格式，防止路径遍历
  if (!/^[0-9a-f]{64}$/.test(hash)) return null
  const filePath = path.join(getPasteCacheDir(), `${hash}.txt`)
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}
