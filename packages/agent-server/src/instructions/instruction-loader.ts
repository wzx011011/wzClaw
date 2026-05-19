// ============================================================
// InstructionLoader — 从 ~/.wzxclaw/ 加载 Skill/Command/MEMORY
// 简化版：只读取文件内容，不做 frontmatter 解析
// ============================================================

import fs from 'fs'
import path from 'path'

/** 加载的指令段落 */
export interface InstructionSections {
  /** skills/*.md 文件内容拼接 */
  skills: string
  /** commands/*.md 文件内容拼接 */
  commands: string
  /** MEMORY.md 内容 */
  memory: string
  /** 合并后的完整指令文本 */
  merged: string
}

const EMPTY_SECTIONS: InstructionSections = {
  skills: '',
  commands: '',
  memory: '',
  merged: '',
}

/**
 * 从配置目录加载所有指令文件
 *
 * 加载顺序（merged 拼接）:
 * 1. MEMORY.md
 * 2. commands/*.md
 * 3. skills/*.md
 */
export function loadInstructions(configDir: string): InstructionSections {
  const memory = readFileContent(path.join(configDir, 'MEMORY.md'))
  const commands = readDirectoryFiles(path.join(configDir, 'commands'))
  const skills = readDirectoryFiles(path.join(configDir, 'skills'))

  const parts: string[] = []
  if (memory) parts.push(`# Memory\n\n${memory}`)
  if (commands) parts.push(`# Commands\n\n${commands}`)
  if (skills) parts.push(`# Skills\n\n${skills}`)

  return {
    skills,
    commands,
    memory,
    merged: parts.join('\n\n---\n\n'),
  }
}

/**
 * 读取单个文件内容，失败返回空字符串
 */
function readFileContent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim()
  } catch {
    return ''
  }
}

/**
 * 读取目录下所有 .md 文件并拼接
 */
function readDirectoryFiles(dirPath: string): string {
  try {
    const files = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.md'))
      .sort()

    const parts: string[] = []
    for (const file of files) {
      const content = readFileContent(path.join(dirPath, file))
      if (content) {
        parts.push(content)
      }
    }
    return parts.join('\n\n')
  } catch {
    return ''
  }
}

/**
 * 获取配置目录路径
 */
export function getConfigDir(): string {
  if (process.env.WZXCLAW_CONFIG_DIR) return process.env.WZXCLAW_CONFIG_DIR
  if (process.env.HOME) return `${process.env.HOME}/.wzxclaw`
  return '/data/config'
}
