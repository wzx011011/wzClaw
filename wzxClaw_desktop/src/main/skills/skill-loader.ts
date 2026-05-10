// ============================================================
// Skill Loader — scans directories for .md skill files
// Loads from: user config, project tree, managed path, legacy commands
// Modeled after Claude Code's loadSkillsDir.ts
// ============================================================

import { realpath, readdir, stat, readFile, access } from 'fs/promises'
import { basename, dirname, join, sep as pathSep } from 'path'
import type { Skill, SkillSource, SkillLoadResult } from '../../shared/types-skill'
import { resolveModelName } from '../../shared/types-skill'
import { parseFrontmatter, extractDescriptionFromMarkdown, splitAndExpandBraces } from './frontmatter-parser'
import { substituteArguments } from './argument-substitution'
import { getSkillsDir, getCommandsDir } from '../paths'

// ============================================================
// Config paths (delegated to paths.ts)
// ============================================================

export const getUserSkillsDir = getSkillsDir
export const getUserCommandsDir = getCommandsDir

/** Managed/policy skills directory — enterprise-controlled path.
 *  Returns undefined if no managed path is configured. */
export function getManagedSkillsDir(): string | undefined {
  // Check for environment variable pointing to a managed skills directory
  const managedPath = process.env.WZXCLAW_MANAGED_SKILLS_DIR
  if (managedPath) return managedPath
  return undefined
}

export function getProjectSkillsDir(projectRoot: string): string {
  return join(projectRoot, '.wzxclaw', 'skills')
}

export function getProjectCommandsDir(projectRoot: string): string {
  return join(projectRoot, '.wzxclaw', 'commands')
}

// ============================================================
// File identity for deduplication
// ============================================================

async function getFileIdentity(filePath: string): Promise<string | null> {
  try {
    return await realpath(filePath)
  } catch {
    return null
  }
}

// ============================================================
// Skill from .md file
// ============================================================

interface SkillWithPath {
  skill: Skill
  filePath: string
}

/**
 * Load a single skill from a .md file.
 */
async function loadSkillFromFile(
  filePath: string,
  skillName: string,
  source: SkillSource,
  baseDir?: string,
): Promise<Skill | null> {
  try {
    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch {
      return null
    }
    const { frontmatter, content: markdownContent } = parseFrontmatter(content, filePath)

    const displayName = frontmatter.name || skillName
    const description = frontmatter.description || extractDescriptionFromMarkdown(markdownContent)
    const paths = frontmatter.paths ? splitAndExpandBraces(frontmatter.paths) : undefined

    // Filter out match-all patterns and strip /** suffix (ignore library treats path as matching contents)
    const filteredPaths = paths
      ?.map(p => p.endsWith('/**') ? p.slice(0, -3) : p)
      .filter(p => p !== '**')
    const effectivePaths = filteredPaths && filteredPaths.length > 0 ? filteredPaths : undefined

    const skill: Skill = {
      name: skillName,
      displayName,
      description,
      hasUserSpecifiedDescription: frontmatter.description !== undefined && frontmatter.description !== null,
      source,
      allowedTools: frontmatter.allowedTools ?? [],
      argumentHint: frontmatter.argumentHint,
      argumentNames: frontmatter.arguments ?? [],
      whenToUse: frontmatter.whenToUse,
      version: frontmatter.version,
      model: resolveModelName(frontmatter.model),
      disableModelInvocation: frontmatter.disableModelInvocation ?? false,
      userInvocable: frontmatter.userInvocable ?? (source === 'legacy' ? true : true),
      executionContext: frontmatter.context ?? 'inline',
      agent: frontmatter.agent,
      effort: frontmatter.effort,
      paths: effectivePaths,
      shell: frontmatter.shell,
      isHidden: frontmatter.hideFromAutocomplete ?? !(frontmatter.userInvocable ?? true),
      skillRoot: baseDir,
      contentLength: markdownContent.length,
      isEnabled: true,
      getPrompt: async (args: string, sessionId?: string) => {
        // Prepend base directory prefix (matches Claude Code behavior)
        let finalContent = baseDir
          ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
          : markdownContent

        // Substitute arguments ($ARGUMENTS, ${ARG_NAME})
        finalContent = substituteArguments(finalContent, args, true, skill.argumentNames)

        // Replace ${WZXCLAW_SKILL_DIR} with skill base directory
        if (baseDir) {
          const skillDir = process.platform === 'win32' ? baseDir.replace(/\\/g, '/') : baseDir
          finalContent = finalContent.replace(/\$\{WZXCLAW_SKILL_DIR\}/g, skillDir)
        }

        // Replace ${SESSION_ID} with current session ID (passed via argument)
        finalContent = finalContent.replace(/\$\{SESSION_ID\}/g, sessionId || 'unknown')

        // Execute embedded shell commands (!`cmd` and ```! blocks)
        // Security: MCP skills should not execute shell commands, but we don't
        // have MCP source yet. All local skills are safe.
        if (finalContent.includes('!`') || finalContent.includes('```!')) {
          try {
            const { executeShellCommandsInPrompt } = require('./prompt-shell-execution')
            finalContent = await executeShellCommandsInPrompt(finalContent, {
              cwd: baseDir,
              shell: skill.shell,
            }, skill.source)
          } catch (err) {
            console.warn(`[skills] Shell execution failed for ${skillName}:`, err)
          }
        }

        return finalContent
      },
    }

    return skill
  } catch (err) {
    console.warn(`[skills] Failed to load skill from ${filePath}:`, err)
    return null
  }
}

// ============================================================
// /skills/ directory loader — directory-name/SKILL.md format
// ============================================================

async function loadSkillsFromSkillsDir(
  basePath: string,
  source: SkillSource,
): Promise<SkillWithPath[]> {
  let entries: string[]

  try {
    entries = await readdir(basePath)
  } catch {
    return []
  }

  const results: SkillWithPath[] = []

  for (const entry of entries) {
    const entryPath = join(basePath, entry)
    let entryStat: { isDirectory(): boolean; isSymbolicLink(): boolean }
    try {
      entryStat = await stat(entryPath)
    } catch {
      continue
    }

    // Only directories (or symlinks to directories) in /skills/
    if (!entryStat.isDirectory() && !entryStat.isSymbolicLink()) continue

    const skillFilePath = join(entryPath, 'SKILL.md')
    try {
      await access(skillFilePath)
    } catch {
      continue
    }

    const skillName = entry
    const skill = await loadSkillFromFile(skillFilePath, skillName, source, entryPath)
    if (skill) {
      results.push({ skill, filePath: skillFilePath })
    }
  }

  return results
}

// ============================================================
// /commands/ directory loader — legacy single .md file format
// ============================================================

function isSkillFile(filePath: string): boolean {
  return /^skill\.md$/i.test(basename(filePath))
}

/**
 * Get command name from file path with namespace support.
 * For SKILL.md: uses parent directory name.
 * For regular .md: uses filename without extension.
 */
function getCommandName(filePath: string, baseDir: string): string {
  const isSkill = isSkillFile(filePath)

  if (isSkill) {
    // skill-name/SKILL.md → skill-name
    const skillDir = dirname(filePath)
    const parentOfSkillDir = dirname(skillDir)
    const commandBaseName = basename(skillDir)
    const namespace = buildNamespace(parentOfSkillDir, baseDir)
    return namespace ? `${namespace}:${commandBaseName}` : commandBaseName
  }

  // command-name.md → command-name
  const fileName = basename(filePath)
  const fileDirectory = dirname(filePath)
  const commandBaseName = fileName.replace(/\.md$/, '')
  const namespace = buildNamespace(fileDirectory, baseDir)
  return namespace ? `${namespace}:${commandBaseName}` : commandBaseName
}

function buildNamespace(targetDir: string, baseDir: string): string {
  const normalizedBaseDir = baseDir.endsWith(pathSep) ? baseDir.slice(0, -1) : baseDir
  if (targetDir === normalizedBaseDir) return ''
  const relativePath = targetDir.slice(normalizedBaseDir.length + 1)
  return relativePath ? relativePath.split(pathSep).join(':') : ''
}

/**
 * When a directory has both SKILL.md and other .md files,
 * only SKILL.md is loaded (takes the directory name).
 */
function transformSkillFiles(files: string[], _baseDir: string): string[] {
  const filesByDir = new Map<string, string[]>()

  for (const file of files) {
    const dir = dirname(file)
    const dirFiles = filesByDir.get(dir) ?? []
    dirFiles.push(file)
    filesByDir.set(dir, dirFiles)
  }

  const result: string[] = []
  for (const [, dirFiles] of filesByDir) {
    const skillFiles = dirFiles.filter(f => isSkillFile(f))
    if (skillFiles.length > 0) {
      result.push(skillFiles[0]!)
    } else {
      result.push(...dirFiles)
    }
  }
  return result
}

async function loadSkillsFromCommandsDir(
  basePath: string,
  source: SkillSource,
): Promise<SkillWithPath[]> {
  // Walk directory recursively for .md files
  const mdFiles = await walkDirForMd(basePath, basePath)
  const processedFiles = transformSkillFiles(mdFiles, basePath)

  const results: SkillWithPath[] = []
  for (const filePath of processedFiles) {
    const isSkill = isSkillFile(filePath)
    const skillDirectory = isSkill ? dirname(filePath) : undefined
    const cmdName = getCommandName(filePath, basePath)

    const skill = await loadSkillFromFile(filePath, cmdName, source, skillDirectory)
    if (skill) {
      results.push({ skill, filePath })
    }
  }

  return results
}

async function walkDirForMd(dir: string, baseDir: string): Promise<string[]> {
  const results: string[] = []

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry)
    let entryStat: { isDirectory(): boolean }
    try {
      entryStat = await stat(fullPath)
    } catch {
      continue
    }

    if (entryStat.isDirectory()) {
      results.push(...await walkDirForMd(fullPath, baseDir))
    } else if (entry.endsWith('.md')) {
      results.push(fullPath)
    }
  }

  return results
}

// ============================================================
// Project directory traversal — walk from cwd up to home
// ============================================================

export function getProjectDirsUpToHome(subdir: 'skills' | 'commands', cwd: string): string[] {
  const home = require('os').homedir()
  const dirs: string[] = []

  let current = cwd
  while (current) {
    dirs.push(join(current, '.wzxclaw', subdir))
    const parent = dirname(current)
    if (parent === current || parent === home) break
    current = parent
  }

  return dirs
}

// ============================================================
// Main loader — combines all sources with deduplication
// ============================================================

export interface LoadSkillsOptions {
  cwd: string
  projectRoots?: string[]
}

export async function loadAllSkills(options: LoadSkillsOptions): Promise<SkillLoadResult> {
  const { cwd, projectRoots = [] } = options
  const errors: Array<{ path: string; error: string }> = []

  // Managed skills dir (enterprise/policy path)
  const managedSkillsDir = getManagedSkillsDir()
  const userSkillsDir = getUserSkillsDir()
  const userCommandsDir = getUserCommandsDir()
  const projectSkillDirs = getProjectDirsUpToHome('skills', cwd)
  const projectCommandDirs = getProjectDirsUpToHome('commands', cwd)

  // Additional project roots (from workspace projects)
  const additionalSkillDirs = projectRoots.flatMap(root =>
    getProjectDirsUpToHome('skills', root)
  )
  const additionalCommandDirs = projectRoots.flatMap(root =>
    getProjectDirsUpToHome('commands', root)
  )

  // Load all sources in parallel
  const allLoadResults = await Promise.all([
    // Managed/policy skills (highest priority source dir)
    managedSkillsDir
      ? loadSkillsFromSkillsDir(managedSkillsDir, 'managed').catch(err => {
          errors.push({ path: managedSkillsDir, error: String(err) })
          return []
        })
      : Promise.resolve([]),
    // User-level skills
    loadSkillsFromSkillsDir(userSkillsDir, 'user').catch(err => {
      errors.push({ path: userSkillsDir, error: String(err) })
      return []
    }),
    // User-level commands (legacy)
    loadSkillsFromCommandsDir(userCommandsDir, 'legacy').catch(err => {
      errors.push({ path: userCommandsDir, error: String(err) })
      return []
    }),
    // Project-level skills
    ...projectSkillDirs.map(dir =>
      loadSkillsFromSkillsDir(dir, 'project').catch(err => {
        errors.push({ path: dir, error: String(err) })
        return []
      })
    ),
    // Project-level commands (legacy)
    ...projectCommandDirs.map(dir =>
      loadSkillsFromCommandsDir(dir, 'legacy').catch(err => {
        errors.push({ path: dir, error: String(err) })
        return []
      })
    ),
    // Additional project roots
    ...additionalSkillDirs.map(dir =>
      loadSkillsFromSkillsDir(dir, 'project').catch(err => {
        errors.push({ path: dir, error: String(err) })
        return []
      })
    ),
    ...additionalCommandDirs.map(dir =>
      loadSkillsFromCommandsDir(dir, 'legacy').catch(err => {
        errors.push({ path: dir, error: String(err) })
        return []
      })
    ),
  ])

  // Flatten
  const allSkillsWithPaths = allLoadResults.flat()

  // Deduplicate by resolved file path (handles symlinks)
  const fileIdentities = await Promise.all(
    allSkillsWithPaths.map(({ filePath }) => getFileIdentity(filePath))
  )

  const seenFileIds = new Set<string>()
  const deduplicated: SkillWithPath[] = []

  for (let i = 0; i < allSkillsWithPaths.length; i++) {
    const entry = allSkillsWithPaths[i]!
    const fileId = fileIdentities[i]

    if (fileId === null || fileId === undefined) {
      deduplicated.push(entry)
      continue
    }

    if (seenFileIds.has(fileId)) {
      console.log(`[skills] Skipping duplicate skill '${entry.skill.name}' (same file already loaded)`)
      continue
    }

    seenFileIds.add(fileId)
    deduplicated.push(entry)
  }

  console.log(
    `[skills] Loaded ${deduplicated.length} skills from ${allSkillsWithPaths.length} files ` +
    `(${allSkillsWithPaths.length - deduplicated.length} duplicates removed)`
  )

  return {
    skills: deduplicated.map(s => s.skill),
    errors,
  }
}

// ============================================================
// Dynamic skill discovery — find skills when touching files
// ============================================================

const dynamicSkillDirs = new Set<string>()
const dynamicSkills = new Map<string, Skill>()

/**
 * Discovers skill directories by walking up from file paths to cwd.
 * Only discovers directories below cwd (cwd-level skills loaded at startup).
 * Skips gitignored directories to prevent e.g. node_modules/pkg/.wzxclaw/skills.
 */
export async function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
): Promise<string[]> {
  const resolvedCwd = cwd.endsWith(pathSep) ? cwd.slice(0, -1) : cwd
  const newDirs: string[] = []

  for (const filePath of filePaths) {
    let currentDir = dirname(filePath)

    // Walk up to cwd but NOT including cwd itself
    // CWD-level skills are already loaded at startup
    while (currentDir.startsWith(resolvedCwd + pathSep)) {
      const skillDir = join(currentDir, '.wzxclaw', 'skills')

      // Skip if we've already checked this path (hit or miss)
      if (!dynamicSkillDirs.has(skillDir)) {
        dynamicSkillDirs.add(skillDir)
        try {
          await stat(skillDir)
          // Check if containing directory is gitignored
          if (await isPathGitignored(currentDir, resolvedCwd)) {
            console.log(`[skills] Skipped gitignored skills dir: ${skillDir}`)
            continue
          }
          newDirs.push(skillDir)
        } catch {
          // Directory doesn't exist — already recorded, skip
        }
      }

      const parent = dirname(currentDir)
      if (parent === currentDir) break
      currentDir = parent
    }
  }

  // Sort by path depth (deepest first) so skills closer to the file take precedence
  return newDirs.sort((a, b) => b.split(pathSep).length - a.split(pathSep).length)
}

/**
 * Check if a path is gitignored.
 * Uses `git check-ignore` which handles nested .gitignore, .git/info/exclude, and global gitignore.
 * Fails open (returns false) if not in a git repo.
 */
async function isPathGitignored(targetPath: string, cwd: string): Promise<boolean> {
  try {
    const { execFile } = require('child_process')
    const { promisify } = require('util')
    const execFileAsync = promisify(execFile)
    await execFileAsync('git', ['check-ignore', '-q', targetPath], {
      cwd,
      timeout: 5000,
    })
    return true // Exit 0 = ignored
  } catch {
    return false // Exit 1 = not ignored, or error/not a git repo
  }
}

/**
 * Loads skills from discovered directories into dynamic skills map.
 * Skills from directories closer to the file (deeper paths) take precedence.
 * Processes in reverse order (shallower first) so deeper paths override.
 */
export async function addDynamicSkillDirectories(dirs: string[]): Promise<void> {
  if (dirs.length === 0) return

  // Load skills from all directories
  const loadedSkills = await Promise.all(
    dirs.map(dir => loadSkillsFromSkillsDir(dir, 'project'))
  )

  // Process in reverse order (shallower first) so deeper paths override
  for (let i = loadedSkills.length - 1; i >= 0; i--) {
    for (const { skill } of loadedSkills[i] ?? []) {
      dynamicSkills.set(skill.name, skill)
    }
  }

  const totalNew = loadedSkills.flat().length
  if (totalNew > 0) {
    console.log(`[skills] Dynamically discovered ${totalNew} skills from ${dirs.length} directories`)
  }
}

/**
 * Get all dynamically discovered skills.
 */
export function getDynamicSkills(): Skill[] {
  return Array.from(dynamicSkills.values())
}

/**
 * Clear dynamic skill state (for testing/cache invalidation).
 */
export function clearDynamicSkills(): void {
  dynamicSkillDirs.clear()
  dynamicSkills.clear()
}
