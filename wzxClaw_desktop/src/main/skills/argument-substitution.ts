// ============================================================
// Argument Substitution for skill prompts
// Modeled after Claude Code's argumentSubstitution.ts
// ============================================================

/**
 * Parses argument names from frontmatter arguments field.
 * Accepts either a string ("arg1, arg2") or string array.
 */
export function parseArgumentNames(value: string | string[] | undefined): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map(s => s.trim()).filter(Boolean)
  return value.split(',').map(s => s.trim()).filter(Boolean)
}

/**
 * Substitutes arguments in a skill prompt template.
 *
 * Supports:
 * - `$ARGUMENTS` → replaced with the raw args string
 * - `${ARG_NAME}` → replaced with the corresponding named argument value
 *
 * Named arguments are extracted from the args string by position.
 * E.g., args="foo bar" with argNames=["file", "pattern"] → file="foo", pattern="bar"
 *
 * @param template The skill markdown content
 * @param args The raw argument string from user input
 * @param escapeBackslash Whether to escape backslashes (Windows path handling)
 * @param argNames Named argument definitions from frontmatter
 */
export function substituteArguments(
  template: string,
  args: string,
  escapeBackslash = true,
  argNames: string[] = [],
): string {
  let result = template

  // Replace $ARGUMENTS with raw args
  result = result.replace(/\$ARGUMENTS/g, args)

  // Replace ${ARG_NAME} with positional args
  if (argNames.length > 0 && args) {
    const parts = splitArgs(args)
    for (let i = 0; i < argNames.length; i++) {
      const argName = argNames[i]!
      const argValue = parts[i] ?? ''
      // Replace both ${name} and $name patterns
      const regex = new RegExp(`\\$\\{${escapeRegExp(argName)}\\}`, 'g')
      result = result.replace(regex, argValue)
    }
  }

  // Replace ${CLAUDE_SKILL_DIR} is handled in skill-loader (needs skillRoot)
  // Replace ${CLAUDE_SESSION_ID} is handled in agent-loop context

  if (escapeBackslash && process.platform === 'win32') {
    // Don't double-escape — only escape if not already escaped
    // Actually, for prompt content we leave paths as-is
  }

  return result
}

/**
 * Splits an argument string by whitespace, respecting quoted strings.
 */
function splitArgs(args: string): string[] {
  const parts: string[] = []
  let current = ''
  let inQuote = false
  let quoteChar = ''

  for (let i = 0; i < args.length; i++) {
    const char = args[i]
    if (inQuote) {
      if (char === quoteChar) {
        inQuote = false
      } else {
        current += char
      }
    } else {
      if (char === '"' || char === "'") {
        inQuote = true
        quoteChar = char
      } else if (char === ' ' || char === '\t') {
        if (current) {
          parts.push(current)
          current = ''
        }
      } else {
        current += char
      }
    }
  }
  if (current) parts.push(current)
  return parts
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
