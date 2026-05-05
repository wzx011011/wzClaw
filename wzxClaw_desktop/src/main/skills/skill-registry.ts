// ============================================================
// Skill Registry — unified registry combining all skill sources
// Modeled after Claude Code's commands.ts getCommands() flow
// ============================================================

import type { Skill, SkillInfo, SkillLoadResult } from '../../shared/types-skill'
import { skillToInfo } from '../../shared/types-skill'
import { loadAllSkills, getDynamicSkills, clearDynamicSkills, discoverSkillDirsForPaths, addDynamicSkillDirectories } from './skill-loader'
import { getBundledSkills, registerBundledSkill } from './bundled-skills'
import { registerConditionalSkill, activateConditionalSkillsForPaths, clearConditionalSkills, getConditionalSkills } from './conditional-skills'
import { pluginRegistry } from '../plugins'

// ============================================================
// Singleton registry
// ============================================================

class SkillRegistry {
  private skills = new Map<string, Skill>()
  private loaded = false
  private loadingPromise: Promise<void> | null = null
  private cwd = ''

  /**
   * Load all skills from all sources. Idempotent — subsequent calls return cached results
   * unless forceReload is true.
   */
  async load(cwd: string, projectRoots: string[] = [], forceReload = false): Promise<void> {
    if (this.loaded && !forceReload && this.cwd === cwd) return

    // Prevent concurrent loads
    if (this.loadingPromise) {
      await this.loadingPromise
      return
    }

    this.loadingPromise = this._load(cwd, projectRoots)
    try {
      await this.loadingPromise
    } finally {
      this.loadingPromise = null
    }
  }

  private async _load(cwd: string, projectRoots: string[]): Promise<void> {
    this.cwd = cwd
    this.skills.clear()

    // 1. Load bundled skills (synchronous, always available)
    const bundled = getBundledSkills()
    for (const skill of bundled) {
      this.skills.set(skill.name, skill)
    }

    // 2. Load file-based skills from all directories
    const result: SkillLoadResult = await loadAllSkills({ cwd, projectRoots })

    // Separate conditional skills from unconditional
    for (const skill of result.skills) {
      if (skill.paths && skill.paths.length > 0) {
        // Register as conditional — only activated when matching files are touched
        registerConditionalSkill(skill)
      } else {
        // Unconditional — add directly
        if (!this.skills.has(skill.name)) {
          this.skills.set(skill.name, skill)
        } else {
          console.log(`[skills] '${skill.name}' from ${skill.source} shadowed by existing entry`)
        }
      }
    }

    // 3. Load plugin skills
    await pluginRegistry.load(cwd, projectRoots)
    const pluginSkills = pluginRegistry.getAllPluginSkills()
    for (const skill of pluginSkills) {
      if (!this.skills.has(skill.name)) {
        this.skills.set(skill.name, skill)
      } else {
        console.log(`[skills] '${skill.name}' from plugin shadowed by existing entry`)
      }
    }

    // 4. Add dynamic skills discovered during previous file operations
    for (const skill of getDynamicSkills()) {
      if (!this.skills.has(skill.name)) {
        this.skills.set(skill.name, skill)
      }
    }

    // Log results
    const count = this.skills.size
    const conditional = getConditionalSkillCount()
    console.log(`[skills] Registry loaded: ${count} active, ${conditional} conditional, ${pluginSkills.length} from plugins`)
    this.loaded = true
  }

  /**
   * Force reload all skills (e.g. after adding a new skill file).
   */
  async reload(cwd: string, projectRoots: string[] = []): Promise<void> {
    this.loaded = false
    await this.load(cwd, projectRoots, true)
  }

  /**
   * Get all active skills (not including pending conditional skills).
   */
  getAll(): Skill[] {
    return Array.from(this.skills.values())
  }

  /**
   * Get all skills as SkillInfo (serialized, safe for IPC).
   */
  getAllInfo(): SkillInfo[] {
    return this.getAll().map(skillToInfo)
  }

  /**
   * Get skills visible to the model (for Skill tool).
   * Includes prompt-type skills that are not disabled.
   */
  getModelInvocableSkills(): Skill[] {
    return this.getAll().filter(
      s => !s.disableModelInvocation && s.source !== 'builtin'
    )
  }

  /**
   * Get skills visible to the user in autocomplete.
   */
  getUserInvocableSkills(): Skill[] {
    return this.getAll().filter(
      s => s.userInvocable && !s.isHidden && s.isEnabled
    )
  }

  /**
   * Find a skill by name or alias.
   */
  find(name: string): Skill | undefined {
    // Direct name match
    const direct = this.skills.get(name)
    if (direct) return direct

    // Alias match
    for (const skill of this.skills.values()) {
      if (skill.aliases?.includes(name)) return skill
    }

    return undefined
  }

  /**
   * Get a skill's prompt content by name.
   */
  async getPrompt(name: string, args: string): Promise<string | null> {
    const skill = this.find(name)
    if (!skill?.getPrompt) return null
    return skill.getPrompt(args)
  }

  /**
   * Discover and activate skills for file paths being operated on.
   * Called when tools touch files (FileRead, FileEdit, etc.)
   *
   * @returns Array of newly activated skill names
   */
  async onFileOperation(filePaths: string[]): Promise<string[]> {
    if (filePaths.length === 0) return []

    const activated: string[] = []

    // 1. Discover new skill directories along file paths
    const newDirs = await discoverSkillDirsForPaths(filePaths, this.cwd)
    if (newDirs.length > 0) {
      await addDynamicSkillDirectories(newDirs)
      // Merge dynamic skills into registry
      for (const skill of getDynamicSkills()) {
        if (!this.skills.has(skill.name)) {
          this.skills.set(skill.name, skill)
          activated.push(skill.name)
        }
      }
    }

    // 2. Activate conditional skills matching these paths
    const conditionalActivated = activateConditionalSkillsForPaths(filePaths, this.cwd)
    for (const name of conditionalActivated) {
      // Find in conditional skills and move to main registry
      // (already removed from conditional map by activateConditionalSkillsForPaths)
      activated.push(name)
    }

    return activated
  }

  /**
   * Get skill count by source.
   */
  getStats(): Record<string, number> {
    const stats: Record<string, number> = {}
    for (const skill of this.skills.values()) {
      stats[skill.source] = (stats[skill.source] ?? 0) + 1
    }
    stats['conditional_pending'] = getConditionalSkillCount()
    return stats
  }
}

// Singleton instance
export const skillRegistry = new SkillRegistry()

// Re-export for convenience
export { registerBundledSkill }

/**
 * Rough token estimation for skill frontmatter (name + description + whenToUse).
 * Used for token budget tracking — full content is only loaded on invocation.
 */
export function estimateSkillTokens(skill: { name: string; description: string; whenToUse?: string }): number {
  const text = [skill.name, skill.description, skill.whenToUse]
    .filter(Boolean)
    .join(' ')
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4)
}
