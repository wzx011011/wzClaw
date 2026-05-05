// ============================================================
// Frontmatter Parser for skill .md files
// Extracts and parses YAML frontmatter between --- delimiters
// Modeled after Claude Code's frontmatterParser.ts
// ============================================================

import type { SkillFrontmatter, SkillShell } from '../../shared/types-skill'

export interface ParsedMarkdown {
  frontmatter: SkillFrontmatter
  content: string
}

// Characters that require quoting in YAML values
const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`]|: /

/**
 * Pre-processes frontmatter text to quote values that contain special YAML characters.
 * This allows glob patterns like star-star-slash-star.{ts,tsx} to be parsed correctly.
 */
function quoteProblematicValues(frontmatterText: string): string {
  const lines = frontmatterText.split('\n')
  const result: string[] = []

  for (const line of lines) {
    const match = line.match(/^([a-zA-Z_-]+):\s+(.+)$/)
    if (match) {
      const [, key, value] = match
      if (!key || !value) {
        result.push(line)
        continue
      }
      // Skip if already quoted
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        result.push(line)
        continue
      }
      // Quote if contains special YAML characters
      if (YAML_SPECIAL_CHARS.test(value)) {
        const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        result.push(`${key}: "${escaped}"`)
        continue
      }
    }
    result.push(line)
  }
  return result.join('\n')
}

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/

/**
 * Minimal YAML parser for flat key-value pairs.
 * Handles: strings, numbers, booleans, single-line arrays ([a, b, c]),
 * and multi-line arrays (- item).
 * Does NOT handle nested mappings or complex YAML features.
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = text.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      i++
      continue
    }

    // Match key: value
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/)
    if (!kvMatch) {
      i++
      continue
    }

    const [, key, rawValue] = kvMatch
    const trimmedValue = rawValue.trim()

    if (trimmedValue === '' || trimmedValue === '|' || trimmedValue === '>') {
      // Could be a multi-line value or empty; check for array items below
      // Collect multi-line array items (- item)
      if (trimmedValue === '' || trimmedValue === '|' || trimmedValue === '>') {
        const items: string[] = []
        i++
        while (i < lines.length) {
          const itemLine = lines[i]!
          const itemMatch = itemLine.match(/^\s+-\s+(.*)$/)
          if (itemMatch) {
            items.push(parseScalar(itemMatch[1]!.trim()) as string)
            i++
          } else {
            break
          }
        }
        if (items.length > 0) {
          result[key!] = items
        } else {
          result[key!] = null
        }
        continue
      }
    }

    // Inline array [a, b, c]
    if (trimmedValue.startsWith('[') && trimmedValue.endsWith(']')) {
      const inner = trimmedValue.slice(1, -1)
      result[key!] = inner.split(',').map(s => parseScalar(s.trim()))
      i++
      continue
    }

    result[key!] = parseScalar(trimmedValue)
    i++
  }

  return result
}

function parseScalar(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  // Strip quotes
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  // Number
  const num = Number(value)
  if (!isNaN(num) && value !== '') return num
  return value
}

/**
 * Parses markdown content to extract frontmatter and body content.
 */
export function parseFrontmatter(markdown: string, sourcePath?: string): ParsedMarkdown {
  const match = markdown.match(FRONTMATTER_REGEX)

  if (!match) {
    return { frontmatter: {}, content: markdown }
  }

  const frontmatterText = match[1] || ''
  const content = markdown.slice(match[0].length)

  let parsed: Record<string, unknown> = {}
  try {
    parsed = parseSimpleYaml(frontmatterText)
  } catch {
    // Retry after quoting problematic values
    try {
      const quotedText = quoteProblematicValues(frontmatterText)
      parsed = parseSimpleYaml(quotedText)
    } catch {
      console.warn(
        `Failed to parse YAML frontmatter${sourcePath ? ` in ${sourcePath}` : ''}`
      )
    }
  }

  const frontmatter: SkillFrontmatter = {
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    allowedTools: parseStringArray(parsed['allowed-tools']),
    argumentHint: typeof parsed['argument-hint'] === 'string' ? parsed['argument-hint'] : undefined,
    arguments: parseStringArray(parsed.arguments),
    whenToUse: typeof parsed.when_to_use === 'string' ? parsed.when_to_use : undefined,
    version: typeof parsed.version === 'string' ? parsed.version : undefined,
    model: typeof parsed.model === 'string' ? parsed.model : undefined,
    disableModelInvocation: parsed['disable-model-invocation'] === true || parsed['disable-model-invocation'] === 'true',
    userInvocable: parsed['user-invocable'] === undefined ? undefined : parsed['user-invocable'] === true || parsed['user-invocable'] === 'true',
    context: parsed.context === 'fork' ? 'fork' : parsed.context === 'inline' ? 'inline' : undefined,
    agent: typeof parsed.agent === 'string' ? parsed.agent : undefined,
    effort: typeof parsed.effort === 'string' ? parsed.effort : undefined,
    paths: parseStringOrStringArray(parsed.paths),
    shell: parseShellValue(parsed.shell),
    hideFromAutocomplete: parsed['hide-from-autocomplete'] === true || parsed['hide-from-autocomplete'] === 'true',
  }

  return { frontmatter, content }
}

function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean)
  if (Array.isArray(value)) return value.map(String)
  return undefined
}

function parseStringOrStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.map(String)
  return undefined
}

function parseShellValue(value: unknown): SkillShell | undefined {
  if (value === 'bash' || value === 'powershell') return value
  return undefined
}

/**
 * Extracts the first non-heading, non-empty paragraph from markdown as a fallback description.
 */
export function extractDescriptionFromMarkdown(markdown: string, fallbackLabel = 'Skill'): string {
  const lines = markdown.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue
    return trimmed.length > 100 ? trimmed.slice(0, 97) + '...' : trimmed
  }
  return fallbackLabel
}

/**
 * Splits a comma-separated string and expands brace patterns.
 * @example
 * splitAndExpandBraces("a, b")           // ["a", "b"]
 * splitAndExpandBraces("*.{ts,tsx}")     // ["*.ts", "*.tsx"]
 */
export function splitAndExpandBraces(input: string | string[]): string[] {
  if (Array.isArray(input)) return input.flatMap(splitAndExpandBraces)
  if (typeof input !== 'string') return []

  const parts: string[] = []
  let current = ''
  let braceDepth = 0

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === '{') { braceDepth++; current += char }
    else if (char === '}') { braceDepth--; current += char }
    else if (char === ',' && braceDepth === 0) {
      const trimmed = current.trim()
      if (trimmed) parts.push(trimmed)
      current = ''
    } else {
      current += char
    }
  }
  const trimmed = current.trim()
  if (trimmed) parts.push(trimmed)

  return parts.filter(p => p.length > 0).flatMap(pattern => expandBraces(pattern))
}

function expandBraces(pattern: string): string[] {
  const braceMatch = pattern.match(/^([^{]*)\{([^}]+)\}(.*)$/)
  if (!braceMatch) return [pattern]

  const prefix = braceMatch[1] || ''
  const alternatives = braceMatch[2] || ''
  const suffix = braceMatch[3] || ''
  const parts = alternatives.split(',').map(alt => alt.trim())

  const expanded: string[] = []
  for (const part of parts) {
    expanded.push(...expandBraces(prefix + part + suffix))
  }
  return expanded
}
