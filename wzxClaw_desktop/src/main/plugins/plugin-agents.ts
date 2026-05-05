// ============================================================
// Plugin Agents — load agent definitions from plugin agents/ dirs
// Agents are .md files that define sub-agent personas/behaviors
// Modeled after Claude Code's agent loading
// ============================================================

import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { basename, join, dirname } from 'path'
import type { LoadedPlugin } from '../../shared/types-plugin'
import type { Skill, SkillSource } from '../../shared/types-skill'
import { resolveModelName } from '../../shared/types-skill'
import { parseFrontmatter, extractDescriptionFromMarkdown } from '../skills/frontmatter-parser'
import { parseArgumentNames, substituteArguments } from '../skills/argument-substitution'

/**
 * A loaded agent from a plugin.
 * Agents are a superset of skills — they have all skill properties
 * plus agent-specific execution context.
 */
export interface PluginAgent {
  /** Unique name: pluginName:agentName */
  name: string
  /** Display name */
  displayName: string
  /** Description */
  description: string
  /** Source plugin name */
  pluginName: string
  /** Agent file path */
  filePath: string
  /** Model override */
  model?: string
  /** Allowed tools */
  allowedTools: string[]
  /** Agent type for forked execution */
  agentType?: string
  /** Effort level */
  effort?: string
  /** Whether the agent is hidden from autocomplete */
  isHidden: boolean
  /** Content length */
  contentLength: number
  /** Get the prompt content */
  getPrompt: (args: string) => Promise<string>
}

export interface PluginAgentResult {
  agents: PluginAgent[]
  errors: Array<{ path: string; error: string }>
}

/**
 * Load all agents from a plugin's agents/ directory.
 *
 * Namespace rule: agents get `pluginName:agentName` naming.
 *
 * Examples:
 *   agents/test-runner.md     → pluginName:test-runner
 *   agents/review/security.md → pluginName:review:security
 */
export function loadPluginAgents(plugin: LoadedPlugin): PluginAgentResult {
  const errors: Array<{ path: string; error: string }> = []
  const agents: PluginAgent[] = []
  const pluginName = plugin.name

  // Collect agent directories
  const agentDirs: string[] = []

  // Standard agents/ directory
  if (plugin.agentsPath) agentDirs.push(plugin.agentsPath)

  // Additional paths from manifest
  if (plugin.agentsPaths) agentDirs.push(...plugin.agentsPaths)

  for (const agentDir of agentDirs) {
    if (!existsSync(agentDir)) continue

    const mdFiles = walkDirForMd(agentDir)
    for (const filePath of mdFiles) {
      try {
        const agent = loadAgentFromFile(filePath, agentDir, pluginName)
        if (agent) {
          agents.push(agent)
        } else {
          errors.push({ path: filePath, error: 'Failed to parse agent file' })
        }
      } catch (err) {
        errors.push({ path: filePath, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  return { agents, errors }
}

/**
 * Load a single agent from a .md file.
 */
function loadAgentFromFile(
  filePath: string,
  baseDir: string,
  pluginName: string,
): PluginAgent | null {
  if (!existsSync(filePath)) return null

  const content = readFileSync(filePath, 'utf-8')
  const { frontmatter, content: markdownContent } = parseFrontmatter(content, filePath)

  const fileName = basename(filePath)
  const fileDirectory = dirname(filePath)
  const agentBaseName = fileName.replace(/\.md$/, '')
  const namespace = buildNamespace(fileDirectory, baseDir)
  const fullName = namespace ? `${pluginName}:${namespace}:${agentBaseName}` : `${pluginName}:${agentBaseName}`

  const displayName = frontmatter.name || agentBaseName
  const description = frontmatter.description || extractDescriptionFromMarkdown(markdownContent)

  const agent: PluginAgent = {
    name: fullName,
    displayName,
    description,
    pluginName,
    filePath,
    model: resolveModelName(frontmatter.model),
    allowedTools: frontmatter.allowedTools ?? [],
    agentType: frontmatter.agent,
    effort: frontmatter.effort,
    isHidden: frontmatter.hideFromAutocomplete ?? false,
    contentLength: markdownContent.length,
    getPrompt: async (args: string) => {
      let finalContent = markdownContent
      finalContent = substituteArguments(finalContent, args, true, frontmatter.arguments ?? [])
      return finalContent
    },
  }

  return agent
}

/**
 * Convert a PluginAgent to a Skill so it integrates with the skill registry.
 */
export function agentToSkill(agent: PluginAgent): Skill {
  return {
    name: agent.name,
    displayName: agent.displayName,
    description: agent.description,
    hasUserSpecifiedDescription: true,
    source: 'plugin' as SkillSource,
    allowedTools: agent.allowedTools,
    argumentNames: [],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'fork', // Agents always run in forked context
    agent: agent.agentType,
    effort: agent.effort,
    isHidden: agent.isHidden,
    contentLength: agent.contentLength,
    isEnabled: true,
    getPrompt: agent.getPrompt,
  }
}

// ---- Helpers ----

function walkDirForMd(dir: string): string[] {
  const results: string[] = []

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry)
    let stat: { isDirectory(): boolean }
    try {
      stat = statSync(fullPath)
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

function buildNamespace(targetDir: string, baseDir: string): string {
  const sep = require('path').sep
  const normalizedBaseDir = baseDir.endsWith(sep) ? baseDir.slice(0, -1) : baseDir
  if (targetDir === normalizedBaseDir) return ''
  const relativePath = targetDir.slice(normalizedBaseDir.length + 1)
  return relativePath ? relativePath.split(sep).join(':') : ''
}
