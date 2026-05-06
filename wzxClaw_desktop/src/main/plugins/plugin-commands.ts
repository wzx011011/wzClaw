// ============================================================
// Plugin Commands — load commands/skills from plugins with namespacing
// Reuses the existing skill-loader pipeline but adds plugin: prefix
// Modeled after Claude Code's loadPluginCommands.ts
// ============================================================

import { promises as fsp, existsSync } from 'fs'
import { basename, dirname, join, sep as pathSep } from 'path'
import type { Skill, SkillSource } from '../../shared/types-skill'
import { resolveModelName } from '../../shared/types-skill'
import { parseFrontmatter, extractDescriptionFromMarkdown, splitAndExpandBraces } from '../skills/frontmatter-parser'
import { substituteArguments } from '../skills/argument-substitution'
import type { LoadedPlugin } from '../../shared/types-plugin'

// ============================================================
// Public API
// ============================================================

export interface PluginCommandResult {
  skills: Skill[]
  errors: Array<{ path: string; error: string }>
}

/**
 * Load all commands/skills from a loaded plugin.
 *
 * Namespace rule: all commands get `pluginName:` prefix
 * Subdirectories create additional namespace segments.
 *
 * Examples:
 *   commands/build.md        → pluginName:build
 *   commands/ui/card.md      → pluginName:ui:card
 *   skills/react-hook/SKILL.md → pluginName:react-hook
 */
export async function loadPluginCommands(plugin: LoadedPlugin): Promise<PluginCommandResult> {
  const errors: Array<{ path: string; error: string }> = []
  const skills: Skill[] = []
  const pluginName = plugin.name

  // Collect all directories to scan for commands/skills
  const commandDirs: string[] = []
  const skillDirs: string[] = []

  // Standard directories
  if (plugin.commandsPath) commandDirs.push(plugin.commandsPath)
  if (plugin.skillsPath) skillDirs.push(plugin.skillsPath)

  // Additional paths from manifest
  if (plugin.commandsPaths) commandDirs.push(...plugin.commandsPaths)
  if (plugin.skillsPaths) skillDirs.push(...plugin.skillsPaths)

  // Load commands (.md files, with SKILL.md support)
  for (const cmdDir of commandDirs) {
    const result = await loadCommandsFromDirectory(cmdDir, pluginName, 'plugin')
    errors.push(...result.errors)
    skills.push(...result.skills)
  }

  // Load skills (SKILL.md directories)
  for (const skillDir of skillDirs) {
    const result = await loadSkillsFromDirectory(skillDir, pluginName, 'plugin')
    errors.push(...result.errors)
    skills.push(...result.skills)
  }

  // Also load inline commands from manifest commands (Record<string, CommandMetadata>)
  const inlineSkills = loadInlineCommands(plugin)
  skills.push(...inlineSkills)

  return { skills, errors }
}

// ============================================================
// Commands directory loader (.md files)
// ============================================================

async function loadCommandsFromDirectory(
  basePath: string,
  pluginName: string,
  source: SkillSource,
): Promise<PluginCommandResult> {
  const errors: Array<{ path: string; error: string }> = []
  const skills: Skill[] = []

  if (!existsSync(basePath)) return { skills, errors }

  const mdFiles = await walkDirForMd(basePath)
  const processedFiles = transformSkillFiles(mdFiles)

  for (const filePath of processedFiles) {
    const isSkill = isSkillFile(filePath)
    const skillDirectory = isSkill ? dirname(filePath) : undefined
    const cmdName = getPluginCommandName(filePath, basePath, pluginName)

    const skill = await loadSkillFromFile(filePath, cmdName, source, skillDirectory)
    if (skill) {
      skills.push(skill)
    } else {
      errors.push({ path: filePath, error: 'Failed to parse skill file' })
    }
  }

  return { skills, errors }
}

// ============================================================
// Skills directory loader (SKILL.md format)
// ============================================================

async function loadSkillsFromDirectory(
  basePath: string,
  pluginName: string,
  source: SkillSource,
): Promise<PluginCommandResult> {
  const errors: Array<{ path: string; error: string }> = []
  const skills: Skill[] = []

  if (!existsSync(basePath)) return { skills, errors }

  let entries: string[]
  try {
    entries = await fsp.readdir(basePath)
  } catch {
    return { skills, errors }
  }

  for (const entry of entries) {
    const entryPath = join(basePath, entry)
    let stat: { isDirectory(): boolean; isSymbolicLink(): boolean }
    try {
      stat = await fsp.stat(entryPath)
    } catch {
      continue
    }

    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue

    const skillFilePath = join(entryPath, 'SKILL.md')
    if (!existsSync(skillFilePath)) continue

    const skillName = `${pluginName}:${entry}`
    const skill = await loadSkillFromFile(skillFilePath, skillName, source, entryPath)
    if (skill) {
      skills.push(skill)
    } else {
      errors.push({ path: skillFilePath, error: 'Failed to parse SKILL.md' })
    }
  }

  return { skills, errors }
}

// ============================================================
// Inline commands from manifest
// ============================================================

function loadInlineCommands(plugin: LoadedPlugin): Skill[] {
  const manifest = plugin.manifest
  const commandsField = manifest.commands
  const skills: Skill[] = []

  if (!commandsField || typeof commandsField !== 'object' || Array.isArray(commandsField)) {
    return skills
  }

  // Record<string, CommandMetadata> format
  for (const [cmdName, meta] of Object.entries(commandsField)) {
    if (typeof meta !== 'object' || meta === null) continue
    const m = meta as { content?: string; description?: string; argumentHint?: string; model?: string; allowedTools?: string[] }

    if (!m.content) continue

    const name = `${plugin.name}:${cmdName}`
    const skill: Skill = {
      name,
      displayName: cmdName,
      description: m.description ?? `Plugin command from ${plugin.name}`,
      hasUserSpecifiedDescription: m.description !== undefined,
      source: 'plugin' as SkillSource,
      allowedTools: m.allowedTools ?? [],
      argumentHint: m.argumentHint,
      argumentNames: [],
      whenToUse: undefined,
      model: resolveModelName(m.model),
      disableModelInvocation: false,
      userInvocable: true,
      executionContext: 'inline',
      isHidden: false,
      contentLength: m.content.length,
      isEnabled: true,
      getPrompt: async (args: string) => {
        let content = m.content!
        content = substituteArguments(content, args, true, [])
        return content
      },
    }
    skills.push(skill)
  }

  return skills
}

// ============================================================
// Shared helpers (adapted from skill-loader.ts)
// ============================================================

function isSkillFile(filePath: string): boolean {
  return /^skill\.md$/i.test(basename(filePath))
}

async function loadSkillFromFile(
  filePath: string,
  skillName: string,
  source: SkillSource,
  baseDir?: string,
): Promise<Skill | null> {
  try {
    if (!existsSync(filePath)) return null

    const content = await fsp.readFile(filePath, 'utf-8')
    const { frontmatter, content: markdownContent } = parseFrontmatter(content, filePath)

    const displayName = frontmatter.name || skillName.split(':').pop() || skillName
    const description = frontmatter.description || extractDescriptionFromMarkdown(markdownContent)
    const paths = frontmatter.paths ? splitAndExpandBraces(frontmatter.paths) : undefined

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
      userInvocable: frontmatter.userInvocable ?? true,
      executionContext: (frontmatter.context as 'inline' | 'fork') ?? 'inline',
      agent: frontmatter.agent,
      effort: frontmatter.effort,
      paths: effectivePaths,
      shell: frontmatter.shell,
      isHidden: frontmatter.hideFromAutocomplete ?? !(frontmatter.userInvocable ?? true),
      skillRoot: baseDir,
      contentLength: markdownContent.length,
      isEnabled: true,
      getPrompt: async (args: string) => {
        let finalContent = baseDir
          ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
          : markdownContent

        finalContent = substituteArguments(finalContent, args, true, skill.argumentNames)

        if (baseDir) {
          const skillDir = process.platform === 'win32' ? baseDir.replace(/\\/g, '/') : baseDir
          finalContent = finalContent.replace(/\$\{WZXCLAW_SKILL_DIR\}/g, skillDir)
        }

        finalContent = finalContent.replace(/\$\{SESSION_ID\}/g, process.env.__WZXCLAW_SESSION_ID__ || 'unknown')

        // Execute embedded shell commands
        if (finalContent.includes('!`') || finalContent.includes('```!')) {
          try {
            const { executeShellCommandsInPrompt } = require('../skills/prompt-shell-execution')
            finalContent = await executeShellCommandsInPrompt(finalContent, {
              cwd: baseDir,
              shell: skill.shell,
            }, 'plugin')
          } catch (err) {
            console.warn(`[plugins] Shell execution failed for ${skillName}:`, err)
          }
        }

        return finalContent
      },
    }

    return skill
  } catch (err) {
    console.warn(`[plugins] Failed to load command from ${filePath}:`, err)
    return null
  }
}

async function walkDirForMd(dir: string): Promise<string[]> {
  const results: string[] = []

  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry)
    let stat: { isDirectory(): boolean }
    try {
      stat = await fsp.stat(fullPath)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      results.push(...walkDirForMd(fullPath))
    } else if (entry.endsWith('.md')) {
      results.push(fullPath)
    }
  }

  return results
}

function transformSkillFiles(files: string[]): string[] {
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

function getPluginCommandName(filePath: string, baseDir: string, pluginName: string): string {
  const isSkill = isSkillFile(filePath)

  if (isSkill) {
    const skillDir = dirname(filePath)
    const parentOfSkillDir = dirname(skillDir)
    const commandBaseName = basename(skillDir)
    const namespace = buildNamespace(parentOfSkillDir, baseDir)
    const fullName = namespace ? `${pluginName}:${namespace}:${commandBaseName}` : `${pluginName}:${commandBaseName}`
    return fullName
  }

  const fileName = basename(filePath)
  const fileDirectory = dirname(filePath)
  const commandBaseName = fileName.replace(/\.md$/, '')
  const namespace = buildNamespace(fileDirectory, baseDir)
  const fullName = namespace ? `${pluginName}:${namespace}:${commandBaseName}` : `${pluginName}:${commandBaseName}`
  return fullName
}

function buildNamespace(targetDir: string, baseDir: string): string {
  const normalizedBaseDir = baseDir.endsWith(pathSep) ? baseDir.slice(0, -1) : baseDir
  if (targetDir === normalizedBaseDir) return ''
  const relativePath = targetDir.slice(normalizedBaseDir.length + 1)
  return relativePath ? relativePath.split(pathSep).join(':') : ''
}
