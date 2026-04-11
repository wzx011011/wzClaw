import path from 'path'
import os from 'os'
import fs from 'fs'
import crypto from 'crypto'

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
    const hash = crypto
      .createHash('md5')
      .update(workspaceRoot)
      .digest('hex')
      .slice(0, 12)

    this.memoryDir = path.join(os.homedir(), '.wzxclaw', 'projects', hash, 'memory')
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
   * Build the memory section string for injection into the system prompt.
   * Always returns the section even when MEMORY.md is empty, so the LLM
   * knows where to write memories.
   */
  buildSystemPromptSection(): Promise<string> {
    return this.readMemory().then((content) => {
      const displayContent = content.trim()
        ? content.trim()
        : '(empty — write important findings here)'

      return `## Auto Memory

Your persistent memory directory is at: ${this.memoryDir}
The file MEMORY.md at ${this.memoryPath} persists across sessions.

Contents of MEMORY.md:
${displayContent}

Instructions:
- When the user asks you to "remember" something, write it to MEMORY.md using the FileWrite tool
- Keep MEMORY.md under 200 lines; condense when it grows large
- Write stable facts: architecture decisions, debugging findings, user preferences
- Do NOT write session-specific or temporary information`
    })
  }
}
