// ============================================================
// Bash Read-Only Command Detection
// ============================================================

// Commands that are safe to run without approval
const READ_ONLY_COMMANDS = new Set([
  // File inspection
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'file', 'stat',
  // Directory listing
  'ls', 'dir', 'tree', 'du', 'df',
  // Search
  'grep', 'rg', 'find', 'fd', 'ag', 'ack', 'locate', 'which', 'whereis', 'type',
  // Git read-only
  'git log', 'git status', 'git show', 'git diff', 'git branch', 'git tag',
  'git remote', 'git stash list', 'git blame', 'git shortlog', 'git describe',
  'git rev-parse', 'git config',
  // Info
  'echo', 'printf', 'pwd', 'whoami', 'hostname', 'uname', 'date', 'env', 'printenv',
  // Node/Python inspection
  'node --version', 'npm --version', 'npx --version', 'python --version', 'pip --version',
  'node -v', 'npm -v', 'python -V'
])

// Git subcommands that are read-only
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'log', 'status', 'show', 'diff', 'branch', 'tag', 'remote', 'blame',
  'shortlog', 'describe', 'rev-parse', 'config', 'ls-files', 'ls-tree',
  'cat-file', 'reflog', 'stash list', 'name-rev', 'rev-list'
])

/**
 * Check if a bash command is read-only (no side effects).
 * Used to skip permission prompts in accept-edits mode.
 */
export function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim()

  // Skip env var prefixes
  const cleaned = trimmed.replace(/^(\w+=\S+\s+)*/, '').trim()

  // Extract first word (or first two words for git)
  const words = cleaned.split(/\s+/)
  const firstWord = words[0]?.toLowerCase() ?? ''

  // Check single-word commands
  if (READ_ONLY_COMMANDS.has(firstWord)) return true

  // Check two-word commands (e.g., "git log")
  if (words.length >= 2) {
    const twoWord = `${firstWord} ${words[1]?.toLowerCase()}`
    if (READ_ONLY_COMMANDS.has(twoWord)) return true
  }

  // Special git handling
  if (firstWord === 'git' && words.length >= 2) {
    const subcommand = words[1]?.toLowerCase() ?? ''
    if (GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return true

    // "git stash list" is read-only, but "git stash pop" is not
    if (subcommand === 'stash' && words.length >= 3) {
      return words[2]?.toLowerCase() === 'list'
    }
  }

  // Piped commands: check if all parts are read-only
  if (cleaned.includes('|') && !cleaned.includes('||')) {
    const parts = cleaned.split('|').map((p) => p.trim())
    return parts.every((part) => isReadOnlyBashCommand(part))
  }

  return false
}
