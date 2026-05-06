// ============================================================
// Conditional Skills — path-filtered skills activated on file touch
// Modeled after Claude Code's conditional skill system
// ============================================================

import { isAbsolute, relative } from 'path'
import type { Skill } from '../../shared/types-skill'

// Pending conditional skills (have paths frontmatter but not yet activated)
const conditionalSkills = new Map<string, Skill>()
// Names of skills that have been activated (survives cache clears within a session)
const activatedConditionalSkillNames = new Set<string>()

/**
 * Register a skill as conditional (it has paths patterns but hasn't matched yet).
 */
export function registerConditionalSkill(skill: Skill): void {
  if (skill.paths && skill.paths.length > 0 && !activatedConditionalSkillNames.has(skill.name)) {
    conditionalSkills.set(skill.name, skill)
  }
}

/**
 * Activate conditional skills whose path patterns match the given file paths.
 * Uses gitignore-style matching (via minimatch).
 *
 * @returns Array of newly activated skill names
 */
export function activateConditionalSkillsForPaths(
  filePaths: string[],
  cwd: string,
): string[] {
  if (conditionalSkills.size === 0) return []

  // Lazy-load minimatch to avoid import overhead when no conditional skills exist
  let minimatch: typeof import('minimatch').minimatch
  try {
    minimatch = require('minimatch').minimatch
  } catch {
    // minimatch not available, skip matching
    return []
  }

  const activated: string[] = []

  for (const [name, skill] of conditionalSkills) {
    if (!skill.paths || skill.paths.length === 0) continue

    for (const filePath of filePaths) {
      const relativePath = isAbsolute(filePath) ? relative(cwd, filePath) : filePath

      if (
        !relativePath ||
        relativePath.startsWith('..') ||
        isAbsolute(relativePath)
      ) {
        continue
      }

      // Normalize separators
      const normalized = relativePath.replace(/\\/g, '/')

      const matched = skill.paths.some(pattern => {
        try {
          return minimatch(normalized, pattern, { dot: true })
        } catch {
          return false
        }
      })

      if (matched) {
        activatedConditionalSkillNames.add(name)
        conditionalSkills.delete(name)
        activated.push(name)
        console.log(`[skills] Activated conditional skill '${name}' (matched: ${normalized})`)
        break
      }
    }
  }

  return activated
}

/**
 * Get all currently pending conditional skills.
 */
export function getConditionalSkills(): Skill[] {
  return Array.from(conditionalSkills.values())
}

/**
 * Get count of pending conditional skills.
 */
export function getConditionalSkillCount(): number {
  return conditionalSkills.size
}

/**
 * Clear conditional skill state (for testing).
 */
export function clearConditionalSkills(): void {
  conditionalSkills.clear()
  activatedConditionalSkillNames.clear()
}
