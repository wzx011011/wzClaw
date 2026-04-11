// ============================================================
// Instruction Loader — Loads WZXCLAW.md project instructions
// ============================================================

import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * Silently reads a file. Returns null if the file does not exist or
 * cannot be read (permission error, directory, etc.).
 */
async function readFileSilent(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Resolve @include directives in content.
 *
 * Syntax: a line that starts with `@include ./relative/path`
 * The path is resolved relative to the file containing the directive.
 * Circular includes are prevented via the visited set.
 */
async function resolveIncludes(
  content: string,
  baseDir: string,
  visited: Set<string> = new Set()
): Promise<string> {
  const lines = content.split('\n')
  const resolved: string[] = []

  for (const line of lines) {
    const match = line.match(/^@include\s+(.+)$/)
    if (match) {
      const includePath = path.resolve(baseDir, match[1].trim())
      if (!visited.has(includePath)) {
        visited.add(includePath)
        const included = await readFileSilent(includePath)
        if (included) {
          const includeResolved = await resolveIncludes(
            included,
            path.dirname(includePath),
            visited
          )
          resolved.push(includeResolved)
        }
      }
      // If already visited or not found, silently skip the @include line
    } else {
      resolved.push(line)
    }
  }

  return resolved.join('\n')
}

/**
 * Load and merge project instructions from all WZXCLAW.md source files.
 *
 * Sources are loaded in priority order (lowest → highest). All found sources
 * are merged with a horizontal rule separator. Missing files are silently skipped.
 *
 * Priority order:
 * 1. `~/.wzxclaw/WZXCLAW.md`                  (global user instructions)
 * 2. `{workspace}/WZXCLAW.md`                  (project root)
 * 3. `{workspace}/.wzxclaw/WZXCLAW.md`         (hidden project dir)
 * 4. `{workspace}/.wzxclaw/rules/*.md`          (split rule files, alphabetical)
 * 5. `{workspace}/WZXCLAW.local.md`             (local overrides, gitignored)
 *
 * Supports `@include ./relative/path` directives for file composition.
 *
 * @param workspaceRoot  Absolute path to the open workspace directory.
 * @returns Formatted instructions string, or empty string if no files found.
 */
export async function loadInstructions(workspaceRoot: string): Promise<string> {
  const homeDir = os.homedir()
  const parts: string[] = []

  // --- 1. Global user instructions ---
  const globalPath = path.join(homeDir, '.wzxclaw', 'WZXCLAW.md')
  const globalContent = await readFileSilent(globalPath)
  if (globalContent) {
    const resolved = await resolveIncludes(globalContent, path.dirname(globalPath))
    const trimmed = resolved.trim()
    if (trimmed) parts.push(trimmed)
  }

  // --- 2. Project root instructions ---
  const projectPath = path.join(workspaceRoot, 'WZXCLAW.md')
  const projectContent = await readFileSilent(projectPath)
  if (projectContent) {
    const resolved = await resolveIncludes(projectContent, workspaceRoot)
    const trimmed = resolved.trim()
    if (trimmed) parts.push(trimmed)
  }

  // --- 3. Hidden project-dir instructions ---
  const hiddenPath = path.join(workspaceRoot, '.wzxclaw', 'WZXCLAW.md')
  const hiddenContent = await readFileSilent(hiddenPath)
  if (hiddenContent) {
    const resolved = await resolveIncludes(hiddenContent, path.dirname(hiddenPath))
    const trimmed = resolved.trim()
    if (trimmed) parts.push(trimmed)
  }

  // --- 4. Split rule files (alphabetical) ---
  const rulesDir = path.join(workspaceRoot, '.wzxclaw', 'rules')
  try {
    const entries = await fs.promises.readdir(rulesDir)
    const mdFiles = entries.filter((f) => f.endsWith('.md')).sort()
    for (const file of mdFiles) {
      const ruleContent = await readFileSilent(path.join(rulesDir, file))
      if (ruleContent) {
        const resolved = await resolveIncludes(ruleContent, rulesDir)
        const trimmed = resolved.trim()
        if (trimmed) parts.push(trimmed)
      }
    }
  } catch {
    // Rules directory does not exist — skip silently
  }

  // --- 5. Local overrides (gitignored) ---
  const localPath = path.join(workspaceRoot, 'WZXCLAW.local.md')
  const localContent = await readFileSilent(localPath)
  if (localContent) {
    const resolved = await resolveIncludes(localContent, workspaceRoot)
    const trimmed = resolved.trim()
    if (trimmed) parts.push(trimmed)
  }

  if (parts.length === 0) return ''

  return `## Project Instructions\n\n${parts.join('\n\n---\n\n')}`
}
