// ============================================================
// Instruction Loader — Loads WZXCLAW.md project instructions
// ============================================================

import fs from 'fs'
import path from 'path'
import { getUserDir, getCommandsDir, getSkillsDir } from '../paths'

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
 * Structured instruction sections for per-category token counting.
 */
export interface InstructionSections {
  /** WZXCLAW.md + rules + local overrides (steps 1-6) */
  instructions: string
  /** ~/.wzxclaw/commands/*.md (step 7) */
  commands: string
  /** ~/.wzxclaw/skills/*.md (step 8) */
  skills: string
  /** Full merged string (backward compat) */
  merged: string
}

/**
 * Load project-level instructions for a single root directory.
 * Loads: WZXCLAW.md + .wzxclaw/WZXCLAW.md + .wzxclaw/rules/*.md + WZXCLAW.local.md
 */
async function loadProjectInstructions(root: string): Promise<string[]> {
  const parts: string[] = []

  // Project root WZXCLAW.md
  const projectPath = path.join(root, 'WZXCLAW.md')
  const projectContent = await readFileSilent(projectPath)
  if (projectContent) {
    const resolved = await resolveIncludes(projectContent, root)
    const trimmed = resolved.trim()
    if (trimmed) parts.push(trimmed)
  }

  // Hidden project-dir instructions
  const hiddenPath = path.join(root, '.wzxclaw', 'WZXCLAW.md')
  const hiddenContent = await readFileSilent(hiddenPath)
  if (hiddenContent) {
    const resolved = await resolveIncludes(hiddenContent, path.dirname(hiddenPath))
    const trimmed = resolved.trim()
    if (trimmed) parts.push(trimmed)
  }

  // Split rule files (alphabetical)
  const rulesDir = path.join(root, '.wzxclaw', 'rules')
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

  // Local overrides (gitignored)
  const localPath = path.join(root, 'WZXCLAW.local.md')
  const localContent = await readFileSilent(localPath)
  if (localContent) {
    const resolved = await resolveIncludes(localContent, root)
    const trimmed = resolved.trim()
    if (trimmed) parts.push(trimmed)
  }

  return parts
}

/**
 * Load instructions as structured sections for per-category analysis.
 *
 * @param roots  Array of project root directories. roots[0] gets full loading
 *               (global + ancestors + project-level), roots[1..N] get project-level only.
 *               Each secondary project's instructions are labeled with its directory name.
 */
export async function loadInstructionSections(roots: string[]): Promise<InstructionSections> {
  const primaryRoot = roots[0]
  const instrParts: string[] = []

  // --- 1. Global user instructions ---
  const globalPath = path.join(getUserDir(), 'WZXCLAW.md')
  const globalContent = await readFileSilent(globalPath)
  if (globalContent) {
    const resolved = await resolveIncludes(globalContent, path.dirname(globalPath))
    const trimmed = resolved.trim()
    if (trimmed) instrParts.push(trimmed)
  }

  // --- 2. Parent directories (walk up from primary root to fs root) ---
  const ancestors: string[] = []
  let current = path.dirname(primaryRoot)
  const fsRoot = path.parse(primaryRoot).root
  while (current !== fsRoot && current !== path.dirname(current)) {
    ancestors.unshift(current)
    current = path.dirname(current)
  }
  for (const ancestor of ancestors) {
    const ancestorPath = path.join(ancestor, 'WZXCLAW.md')
    const ancestorContent = await readFileSilent(ancestorPath)
    if (ancestorContent) {
      const resolved = await resolveIncludes(ancestorContent, ancestor)
      const trimmed = resolved.trim()
      if (trimmed) instrParts.push(trimmed)
    }
  }

  // --- 3-6. Primary root: full project-level loading ---
  const primaryParts = await loadProjectInstructions(primaryRoot)
  instrParts.push(...primaryParts)

  // --- Secondary roots: project-level only, labeled by project name ---
  for (let i = 1; i < roots.length; i++) {
    const root = roots[i]
    const projectName = path.basename(root)
    const secondaryParts = await loadProjectInstructions(root)
    if (secondaryParts.length > 0) {
      instrParts.push(`## Project: ${projectName} (${root})`)
      instrParts.push(...secondaryParts)
    }
  }

  // --- 7. User custom commands (~/.wzxclaw/commands/*.md) ---
  const commandParts: string[] = []
  try {
    const cmdEntries = await fs.promises.readdir(getCommandsDir())
    const cmdFiles = cmdEntries.filter(f => f.endsWith('.md')).sort()
    for (const file of cmdFiles) {
      const cmdContent = await readFileSilent(path.join(getCommandsDir(), file))
      if (cmdContent?.trim()) commandParts.push(cmdContent.trim())
    }
  } catch { /* commands dir missing — skip silently */ }

  // --- 8. User custom skills (~/.wzxclaw/skills/*.md) ---
  const skillParts: string[] = []
  try {
    const skillEntries = await fs.promises.readdir(getSkillsDir())
    const skillFiles = skillEntries.filter(f => f.endsWith('.md')).sort()
    for (const file of skillFiles) {
      const skillContent = await readFileSilent(path.join(getSkillsDir(), file))
      if (skillContent?.trim()) skillParts.push(skillContent.trim())
    }
  } catch { /* skills dir missing — skip silently */ }

  // Build individual section strings
  const instructions = instrParts.length > 0 ? instrParts.join('\n\n---\n\n') : ''
  const commands = commandParts.length > 0
    ? `## Available Commands\n\n${commandParts.join('\n\n---\n\n')}`
    : ''
  const skills = skillParts.length > 0
    ? `## Additional Skills\n\n${skillParts.join('\n\n---\n\n')}`
    : ''

  // Merge all into combined string
  const allParts: string[] = []
  if (instructions) allParts.push(instructions)
  if (commands) allParts.push(commands)
  if (skills) allParts.push(skills)

  const merged = allParts.length > 0
    ? `## Project Instructions\n\n${allParts.join('\n\n---\n\n')}`
    : ''

  return { instructions, commands, skills, merged }
}

/**
 * Load and merge project instructions from all WZXCLAW.md source files.
 *
 * @param workspaceRoot  Absolute path to the open workspace directory.
 * @returns Formatted instructions string, or empty string if no files found.
 */
export async function loadInstructions(workspaceRoot: string): Promise<string> {
  return (await loadInstructionSections([workspaceRoot])).merged
}
