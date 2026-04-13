import path from 'path'
import fs from 'fs'
import { getProjectMemoryDir, getGlobalMemoryPath } from '../paths'

// ============================================================
// MemoryManager — Cross-session MEMORY.md persistence
// ============================================================

/**
 * Manages a project-scoped MEMORY.md file that persists facts across sessions.
 *
 * Storage layout:
 *   ~/.wzxclaw/projects/{md5(workspaceRoot)[0:12]}/memory/MEMORY.md
 *
 * The hash gives a stable, collision-resistant directory name derived from
 * the workspace path without encoding filesystem-unsafe characters.
 */
export class MemoryManager {
  private memoryDir: string
  private memoryPath: string

  constructor(workspaceRoot: string) {
    this.memoryDir = getProjectMemoryDir(workspaceRoot)
    this.memoryPath = path.join(this.memoryDir, 'MEMORY.md')
  }

  /** Absolute path to the MEMORY.md file (may not exist yet). */
  getMemoryPath(): string {
    return this.memoryPath
  }

  /** Absolute path to the memory directory (may not exist yet). */
  getMemoryDir(): string {
    return this.memoryDir
  }

  /**
   * Read the current MEMORY.md contents.
   * Returns an empty string if the file does not exist or cannot be read.
   */
  async readMemory(): Promise<string> {
    try {
      return await fs.promises.readFile(this.memoryPath, 'utf-8')
    } catch {
      return ''
    }
  }

  /**
   * Read all *.md files from the memory directory.
   * Returns a map of filename → content for all files found.
   */
  async readAllMemoryFiles(): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    try {
      const entries = await fs.promises.readdir(this.memoryDir)
      const mdFiles = entries.filter((f) => f.endsWith('.md')).sort()
      for (const file of mdFiles) {
        try {
          const content = await fs.promises.readFile(path.join(this.memoryDir, file), 'utf-8')
          if (content.trim()) result.set(file, content)
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // directory doesn't exist yet
    }
    return result
  }

  /**
   * Build the memory section string for injection into the system prompt.
   * Loads global MEMORY.md (~/.wzxclaw/MEMORY.md) and all project *.md files.
   * Global memory is loaded first; project memory takes priority (shown last).
   * Combined lines capped at 200 — global is truncated first when over limit.
   */
  async buildSystemPromptSection(): Promise<string> {
    const [globalRaw, projectFiles] = await Promise.all([
      this.readGlobalMemory(),
      this.readAllMemoryFiles(),
    ])

    const MAX_LINES = 200
    const projectLines: string[] = []
    for (const [fname, content] of projectFiles) {
      projectLines.push(`### ${fname}`, content.trim(), '')
    }
    const projectBlock = projectLines.join('\n')

    let globalBlock = ''
    if (globalRaw.trim()) {
      const projectLineCount = projectLines.length
      const remaining = Math.max(0, MAX_LINES - projectLineCount)
      const truncated = globalRaw.split('\n').slice(0, remaining).join('\n')
      globalBlock = truncated.trim()
    }

    let filesContent = ''
    if (!globalBlock && projectFiles.size === 0) {
      filesContent = 'MEMORY.md: (empty — write important findings here)'
    } else {
      if (globalBlock) {
        filesContent += `### [Global MEMORY.md]\n${globalBlock}\n\n`
      }
      if (projectFiles.size > 0) {
        filesContent += `### [Project Memory]\n${projectBlock}`
      }
    }

    return `## Auto Memory

Your persistent memory directory is at: ${this.memoryDir}
Primary file: ${this.memoryPath}
Global memory file: ${getGlobalMemoryPath()}

${filesContent}

Instructions:
- When the user asks you to "remember" something, write it to MEMORY.md using FileWrite
- For cross-project preferences, write to the global memory file: ${getGlobalMemoryPath()}
- Organize by topic: create separate files (e.g. patterns.md, debugging.md) for distinct subjects
- Keep each file under 200 lines; condense when it grows large
- Write stable facts: architecture decisions, debugging findings, user preferences
- Do NOT write session-specific or temporary information
- Lines after 200 in MEMORY.md will be truncated in future sessions`
  }

  /** Read global MEMORY.md. Returns empty string if it doesn't exist. */
  private async readGlobalMemory(): Promise<string> {
    try {
      return await fs.promises.readFile(getGlobalMemoryPath(), 'utf-8')
    } catch {
      return ''
    }
  }
}