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

// ============================================================
// Bash → 专用工具重定向检测
// cat/head/tail → FileRead, grep/rg → Grep, find → Glob
// ============================================================

/** 可重定向命令的映射结果 */
export interface RedirectableCommand {
  targetTool: string       // 'FileRead' | 'Grep' | 'Glob'
  mappedInput: Record<string, unknown>
}

/**
 * 检测 Bash 命令是否可重定向到专用工具。
 * 仅处理简单单命令模式。复杂管道/变量/命令替换均返回 null。
 */
export function getRedirectableCommand(command: string): RedirectableCommand | null {
  const trimmed = command.trim()

  // 跳过管道、链式、分号
  if (trimmed.includes('|') || trimmed.includes('&&') || trimmed.includes(';')) return null
  // 跳过 shell 变量和命令替换
  if (/\$\(/.test(trimmed) || trimmed.includes('`') || /\$\w/.test(trimmed)) return null
  // 跳过重定向操作符（但允许 --flags 中包含 >）
  if (/[^-]>/.test(trimmed) && !trimmed.includes('--')) return null

  // 去掉环境变量前缀
  const cleaned = trimmed.replace(/^\w+=\S+\s*/, '').trim()
  if (!cleaned) return null
  const parts = cleaned.split(/\s+/)
  const cmd = parts[0]?.toLowerCase() ?? ''

  // cat/head/tail → FileRead
  if (cmd === 'cat' || cmd === 'head' || cmd === 'tail') {
    const filePath = findFirstNonFlag(parts)
    if (!filePath) return null
    const input: Record<string, unknown> = { path: filePath }
    // head/tail -n N → limit: N
    const nFlag = findFlagValue(parts, ['-n', '--lines'])
    if (nFlag && cmd !== 'cat') input.limit = Number(nFlag)
    return { targetTool: 'FileRead', mappedInput: input }
  }

  // grep/rg → Grep
  if (cmd === 'grep' || cmd === 'rg') {
    let pattern: string | null = null
    let filePath: string | null = null
    let caseInsensitive = false
    let globPattern: string | null = null
    let i = 1
    while (i < parts.length) {
      const p = parts[i]
      if (p === '-i' || p === '--ignore-case') { caseInsensitive = true; i++; continue }
      if (p === '-r' || p === '-R' || p === '--recursive') { i++; continue }
      if (p === '-l' || p === '--files-with-matches') { i++; continue }
      if (p === '-c' || p === '--count') { i++; continue }
      if (p.startsWith('--include=')) { globPattern = p.split('=')[1]; i++; continue }
      if (p === '--include' && parts[i + 1]) { globPattern = parts[++i]; i++; continue }
      if (p.startsWith('-g') && p.length > 2) { globPattern = p.slice(2); i++; continue }
      if (p === '-g' && parts[i + 1]) { globPattern = parts[++i]; i++; continue }
      // 遇到不认识的 flag 时不重定向，避免误映射
      if (p.startsWith('-')) return null
      if (pattern === null) { pattern = p }
      else if (filePath === null) { filePath = p }
      else return null  // 参数过多，不重定向
      i++
    }
    if (!pattern) return null
    const input: Record<string, unknown> = { pattern: caseInsensitive ? `(?i)${pattern}` : pattern }
    if (filePath) input.path = filePath
    if (globPattern) input.glob = globPattern
    return { targetTool: 'Grep', mappedInput: input }
  }

  // find -name → Glob（仅简单模式）
  if (cmd === 'find') {
    let searchPath: string | null = null
    let namePattern: string | null = null
    let hasUnsupported = false
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i]
      if (p === '-name' && parts[i + 1]) {
        namePattern = parts[++i].replace(/^['"]|['"]$/g, '')
      } else if (p === '-type' && parts[i + 1]) {
        i++  // 跳过 type 参数 — Glob 无法按类型过滤
      } else if (!p.startsWith('-') && searchPath === null) {
        searchPath = p
      } else {
        hasUnsupported = true
        break
      }
    }
    if (hasUnsupported || !namePattern) return null
    // find 默认递归搜索 — 没有通配符时加 ** 前缀
    let globPat = namePattern
    if (!globPat.includes('*') && !globPat.includes('/') && !globPat.includes('?')) {
      globPat = `**/${globPat}`
    } else if (globPat.startsWith('*') && !globPat.startsWith('**')) {
      globPat = `**/${globPat}`
    }
    const input: Record<string, unknown> = { pattern: globPat }
    if (searchPath && searchPath !== '.') input.path = searchPath
    return { targetTool: 'Glob', mappedInput: input }
  }

  return null
}

/** 找到第一个非 flag 参数（用作文件路径） */
function findFirstNonFlag(parts: string[]): string | null {
  for (let i = 1; i < parts.length; i++) {
    if (!parts[i].startsWith('-')) return parts[i]
  }
  return null
}

/** 找到指定 flag 的值，支持 -n20 合并形式 */
function findFlagValue(parts: string[], flags: string[]): string | null {
  for (let i = 0; i < parts.length - 1; i++) {
    if (flags.includes(parts[i])) return parts[i + 1]
  }
  for (const p of parts) {
    for (const f of flags) {
      if (p.startsWith(f) && p.length > f.length) return p.slice(f.length)
    }
  }
  return null
}
