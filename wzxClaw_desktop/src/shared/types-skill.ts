// ============================================================
// Skill / Command Type System (modeled after Claude Code)
// ============================================================

/**
 * Where a skill was loaded from.
 * - 'bundled'   — compiled into the app, always available
 * - 'user'      — ~/.wzxclaw/skills/
 * - 'project'   — .wzxclaw/skills/ in project tree
 * - 'managed'   — enterprise/policy-managed path
 * - 'mcp'       — discovered via MCP protocol
 * - 'legacy'    — .wzxclaw/commands/ (deprecated single-file format)
 * - 'plugin'    — loaded from an installed plugin
 * - 'builtin'   — hardcoded in renderer (help, compact, etc.)
 */
export type SkillSource = 'bundled' | 'user' | 'project' | 'managed' | 'mcp' | 'legacy' | 'plugin' | 'builtin'

/**
 * Execution context for a skill.
 * - 'inline' — skill content is injected into the current conversation (default)
 * - 'fork'   — skill runs in a sub-agent with separate context and token budget
 */
export type SkillExecutionContext = 'inline' | 'fork'

/**
 * Shell to use for !`cmd` and ```! blocks in skill markdown.
 */
export type SkillShell = 'bash' | 'powershell'

/** Valid effort levels */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * Validate effort value from frontmatter.
 * Accepts: 'low', 'medium', 'high', 'max', or integer string.
 * Returns parsed value or undefined if invalid.
 */
export function parseEffortValue(value: unknown): string | number | undefined {
  if (value === undefined || value === null) return undefined
  const str = String(value).trim().toLowerCase()
  if (EFFORT_LEVELS.includes(str as EffortLevel)) return str
  const num = parseInt(str, 10)
  if (Number.isInteger(num) && num > 0) return num
  return undefined
}

/**
 * Parsed frontmatter from a skill .md file.
 */
export interface SkillFrontmatter {
  /** Explicit display name (overrides file/directory name) */
  name?: string
  /** Short description shown in autocomplete and skill listings */
  description?: string
  /** Tools allowed when this skill is active */
  allowedTools?: string[]
  /** Hint text for arguments, displayed in gray after command name */
  argumentHint?: string
  /** Named argument definitions */
  arguments?: string[]
  /** Detailed usage scenarios for when to use this skill */
  whenToUse?: string
  /** Version string */
  version?: string
  /** Model override (e.g. 'haiku', 'sonnet', or specific model name) */
  model?: string
  /** Whether the model can invoke this skill via Skill tool */
  disableModelInvocation?: boolean
  /** Whether users can invoke this skill by typing /skill-name */
  userInvocable?: boolean
  /** Execution context: 'inline' or 'fork' */
  context?: SkillExecutionContext
  /** Agent type when forked */
  agent?: string
  /** Thinking effort level */
  effort?: string
  /** Glob patterns for file paths this skill applies to (conditional skills) */
  paths?: string[]
  /** Shell to use for !`cmd` blocks */
  shell?: SkillShell
  /** Whether to hide from slash command autocomplete */
  hideFromAutocomplete?: boolean
}

/**
 * A fully resolved skill/command ready for use.
 * This is the unified type used by the registry, IPC, and UI.
 */
export interface Skill {
  /** Unique name (no slash prefix), e.g. "commit" or "ns:my-skill" */
  name: string
  /** Display name (may differ from name, e.g. for namespaced skills) */
  displayName: string
  /** Short description */
  description: string
  /** Whether the user explicitly provided a description in frontmatter */
  hasUserSpecifiedDescription: boolean
  /** Source of this skill */
  source: SkillSource
  /** Tools allowed when this skill is active */
  allowedTools: string[]
  /** Argument hint displayed in autocomplete */
  argumentHint?: string
  /** Named arguments extracted from frontmatter */
  argumentNames: string[]
  /** When-to-use text for model invocation context */
  whenToUse?: string
  /** Version */
  version?: string
  /** Model override */
  model?: string
  /** Whether model can invoke this */
  disableModelInvocation: boolean
  /** Whether users can invoke by typing /name */
  userInvocable: boolean
  /** Execution context */
  executionContext: SkillExecutionContext
  /** Agent type when forked */
  agent?: string
  /** Effort level */
  effort?: string
  /** File path patterns for conditional activation */
  paths?: string[]
  /** Shell for !`cmd` blocks */
  shell?: SkillShell
  /** Whether to hide from autocomplete */
  isHidden: boolean
  /** Base directory for skill resources */
  skillRoot?: string
  /** Content length in characters (for token estimation) */
  contentLength: number
  /** Aliases */
  aliases?: string[]
  /** Whether this skill is currently enabled */
  isEnabled: boolean
  /**
   * Get the prompt content for this skill.
   * For file-based skills, this returns the markdown body with arguments substituted.
   * For builtin/action skills, this is not applicable.
   */
  getPrompt?: (args: string) => Promise<string>
}

/**
 * Skill info sent over IPC (serialized form without functions).
 */
export interface SkillInfo {
  name: string
  displayName: string
  description: string
  hasUserSpecifiedDescription: boolean
  source: SkillSource
  allowedTools: string[]
  argumentHint?: string
  argumentNames: string[]
  whenToUse?: string
  version?: string
  model?: string
  disableModelInvocation: boolean
  userInvocable: boolean
  executionContext: SkillExecutionContext
  agent?: string
  effort?: string
  paths?: string[]
  shell?: SkillShell
  isHidden: boolean
  skillRoot?: string
  contentLength: number
  aliases?: string[]
  isEnabled: boolean
}

/** Convert Skill → SkillInfo (strip functions) */
export function skillToInfo(skill: Skill): SkillInfo {
  const { getPrompt: _gp, ...info } = skill
  return info
}

/** Convert SkillInfo back to Skill with a simple getPrompt that fetches from main */
export function infoToSkill(info: SkillInfo, getPromptFn?: (args: string) => Promise<string>): Skill {
  return {
    ...info,
    getPrompt: getPromptFn,
  }
}

/**
 * Model alias mapping — resolves short names to full model IDs.
 * Mirrors Claude Code's model alias system.
 */
const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-3-5-haiku-20241022',
  sonnet: 'claude-sonnet-4-20250514',
  opus: 'claude-opus-4-20250514',
}

/**
 * Resolve a model name from frontmatter.
 * - 'inherit' → undefined (use parent model)
 * - Known alias → full model ID
 * - Otherwise → return as-is
 */
export function resolveModelName(model: string | undefined): string | undefined {
  if (!model) return undefined
  if (model === 'inherit') return undefined
  const lower = model.toLowerCase()
  return MODEL_ALIASES[lower] ?? model
}

/**
 * Result of loading skills from a directory.
 */
export interface SkillLoadResult {
  skills: Skill[]
  errors: Array<{ path: string; error: string }>
}
