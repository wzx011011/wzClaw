import path from 'path'
import fs from 'fs'
import { getProjectMemoryDir } from '../paths'

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
   * Loads all *.md files from the memory directory (multi-topic support).
   * Always returns the section even when empty, so the LLM knows where to write.
   */
  async buildSystemPromptSection(): Promise<string> {
    const files = await this.readAllMemoryFiles()

    let filesContent = ''
    if (files.size === 0) {
      filesContent = 'MEMORY.md: (empty — write important findings here)'
    } else {
      for (const [fname, content] of files) {
        filesContent += `\n### ${fname}\n${content.trim()}\n`
      }
    }

    return `## Auto Memory

Your persistent memory directory is at: ${this.memoryDir}
Primary file: ${this.memoryPath}

${filesContent}

Instructions:
- When the user asks you to "remember" something, write it to MEMORY.md using FileWrite
- Organize by topic: create separate files (e.g. patterns.md, debugging.md) for distinct subjects
- Keep each file under 200 lines; condense when it grows large
- Write stable facts: architecture decisions, debugging findings, user preferences
- Do NOT write session-specific or temporary information
- Lines after 200 in MEMORY.md will be truncated in future sessions`
  }
}
