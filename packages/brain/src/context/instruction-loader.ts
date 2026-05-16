// ============================================================
// InstructionLoader — 指令文件加载器
//
// 从配置目录加载 MEMORY.md、commands/*.md、skills/*.md，
// 支持 @include 指令递归展开。
// 纯 Node.js fs，无 Electron 依赖。
// ============================================================

import { readFile, readdir } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

/** Collect all entries from an AsyncIterable into an array (ES2022 compat) */
async function collectAsync<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iter) result.push(item)
  return result
}

/** 加载结果 */
export interface InstructionSections {
  memory: string
  commands: string
  skills: string
  merged: string
}

const EMPTY_SECTIONS: InstructionSections = {
  memory: '',
  commands: '',
  skills: '',
  merged: '',
}

/**
 * 静默读取文件，失败返回 null
 */
async function readFileSilent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * 递归解析 @include 指令
 *
 * 格式：@include ./relative/path.md
 * 防止循环引用（visited set）
 */
async function resolveIncludes(
  content: string,
  baseDir: string,
  visited: Set<string> = new Set(),
): Promise<string> {
  const includeRegex = /@include\s+\.\/([^\s\n]+)/g
  const matches = [...content.matchAll(includeRegex)]

  if (matches.length === 0) return content

  let result = content
  for (const match of matches) {
    const includePath = resolve(baseDir, match[1]!)
    if (visited.has(includePath)) {
      result = result.replace(match[0], `<!-- circular include: ${match[1]} -->`)
      continue
    }
    visited.add(includePath)
    const included = await readFileSilent(includePath)
    if (included) {
      const resolved = await resolveIncludes(included, dirname(includePath), visited)
      result = result.replace(match[0], resolved)
    } else {
      result = result.replace(match[0], `<!-- include not found: ${match[1]} -->`)
    }
  }

  return result
}

/**
 * loadInstructions — 从配置目录加载所有指令文件
 *
 * @param configDir 配置目录路径（如 ~/.wzxclaw）
 * @returns 指令节内容
 */
export async function loadInstructions(configDir: string): Promise<InstructionSections> {
  if (!configDir || !existsSync(configDir)) {
    return EMPTY_SECTIONS
  }

  // MEMORY.md
  const memoryRaw = await readFileSilent(join(configDir, 'MEMORY.md'))
  const memory = memoryRaw ? `# Memory\n\n${memoryRaw}` : ''

  // commands/*.md
  const commandsDir = join(configDir, 'commands')
  const commandFiles = existsSync(commandsDir)
    ? (await readdir(commandsDir)).filter(f => f.endsWith('.md')).map(f => join(commandsDir, f)).sort()
    : []
  const commandContents: string[] = []
  for (const file of commandFiles) {
    const raw = await readFileSilent(file)
    if (raw) {
      const resolved = await resolveIncludes(raw, dirname(file))
      commandContents.push(resolved)
    }
  }
  const commands = commandContents.length > 0
    ? `# Commands\n\n${commandContents.join('\n\n---\n\n')}`
    : ''

  // skills/*.md
  const skillsDir = join(configDir, 'skills')
  const skillFiles = existsSync(skillsDir)
    ? (await readdir(skillsDir)).filter(f => f.endsWith('.md')).map(f => join(skillsDir, f)).sort()
    : []
  const skillContents: string[] = []
  for (const file of skillFiles) {
    const raw = await readFileSilent(file)
    if (raw) {
      const resolved = await resolveIncludes(raw, dirname(file))
      skillContents.push(resolved)
    }
  }
  const skills = skillContents.length > 0
    ? `# Skills\n\n${skillContents.join('\n\n---\n\n')}`
    : ''

  // 合并
  const parts: string[] = []
  if (memory) parts.push(memory)
  if (commands) parts.push(commands)
  if (skills) parts.push(skills)
  const merged = parts.join('\n\n---\n\n')

  return { memory, commands, skills, merged }
}
