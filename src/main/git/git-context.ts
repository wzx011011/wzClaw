import { execFile } from 'child_process'

// ============================================================
// Git Context Injection
// ============================================================

interface GitContext {
  branch: string
  status: string
  recentLog: string
  userName: string
}

const STATUS_MAX_CHARS = 2000

/** Cache git context to avoid spawning 4 subprocesses per agent turn. */
const GIT_CACHE_TTL_MS = 10_000
let _gitContextCache: { cwd: string; result: string; timestamp: number } | null = null

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve('')
        return
      }
      resolve(stdout.trim())
    })
  })
}

/**
 * Gather git context for the given working directory.
 * Runs git commands in parallel, caps output, and returns a formatted string
 * suitable for prepending to the system prompt.
 */
export async function getGitContext(cwd: string): Promise<string> {
  // Return cached result if still fresh and same workspace
  if (_gitContextCache && _gitContextCache.cwd === cwd && Date.now() - _gitContextCache.timestamp < GIT_CACHE_TTL_MS) {
    return _gitContextCache.result
  }

  const [branch, status, log, userName] = await Promise.all([
    execGit(['branch', '--show-current'], cwd),
    execGit(['--no-optional-locks', 'status', '--short'], cwd),
    execGit(['--no-optional-locks', 'log', '--oneline', '-n', '5'], cwd),
    execGit(['config', 'user.name'], cwd)
  ])

  // If not a git repo, return empty
  if (!branch && !status && !log) {
    return ''
  }

  const truncatedStatus =
    status.length > STATUS_MAX_CHARS
      ? status.substring(0, STATUS_MAX_CHARS) + '\n... [truncated]'
      : status

  const parts: string[] = ['## Git Context']
  if (userName) parts.push(`User: ${userName}`)
  if (branch) parts.push(`Branch: ${branch}`)
  if (truncatedStatus) parts.push(`Status:\n${truncatedStatus}`)
  if (log) parts.push(`Recent commits:\n${log}`)

  const result = parts.join('\n')
  _gitContextCache = { cwd, result, timestamp: Date.now() }
  return result
}

/** Invalidate git cache (call on file changes that may affect git status). */
export function invalidateGitCache(): void {
  _gitContextCache = null
}

/**
 * Get branch name only (for status bar display).
 */
export async function getGitBranch(cwd: string): Promise<string> {
  return execGit(['branch', '--show-current'], cwd)
}

/**
 * Get short git status (for UI display).
 */
export async function getGitStatusShort(cwd: string): Promise<{ branch: string; changedFiles: number }> {
  const [branch, status] = await Promise.all([
    execGit(['branch', '--show-current'], cwd),
    execGit(['--no-optional-locks', 'status', '--short'], cwd)
  ])
  const changedFiles = status ? status.split('\n').filter((l) => l.trim()).length : 0
  return { branch, changedFiles }
}
