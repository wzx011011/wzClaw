// ============================================================
// Bash Security Analysis
// ============================================================

export interface SecurityResult {
  safe: boolean
  warnings: string[]
  blocked: boolean
  reason?: string
}

// Patterns that should be blocked outright
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\/($|\s)/, reason: 'Recursive delete of root filesystem' },
  { pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/($|\s)/, reason: 'Recursive delete of root filesystem' },
  { pattern: /mkfs\./, reason: 'Filesystem format command' },
  { pattern: /dd\s+.*of=\/dev\/[sh]d/, reason: 'Raw disk write' },
  { pattern: /:\(\)\{\s*:\|:\s*&\s*\};\s*:/, reason: 'Fork bomb' },
  { pattern: />\s*\/dev\/[sh]d/, reason: 'Direct device write' },
]

// Patterns that generate warnings but aren't blocked
const WARNING_PATTERNS: Array<{ pattern: RegExp; warning: string }> = [
  { pattern: /\bsudo\b/, warning: 'Command uses sudo (elevated privileges)' },
  { pattern: /\bchmod\s+777\b/, warning: 'chmod 777 makes files world-writable' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh/, warning: 'Piping remote content to shell' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh/, warning: 'Piping remote content to shell' },
  { pattern: /\beval\b/, warning: 'Command uses eval (dynamic execution)' },
  { pattern: />\s*\/etc\//, warning: 'Writing to /etc/ system directory' },
  { pattern: />\s*~\/\.(bash|zsh|profile|gitconfig)/, warning: 'Writing to shell/git config file' },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*)/, warning: 'Recursive or forced delete' },
  { pattern: /\$\(.*\)/, warning: 'Command substitution detected' },
  { pattern: /`[^`]+`/, warning: 'Backtick command substitution detected' },
  { pattern: />\s*\/proc\//, warning: 'Writing to /proc/' },
  { pattern: />\s*\/dev\//, warning: 'Writing to /dev/' },
]

// Sensitive paths that should trigger warnings when accessed
const SENSITIVE_PATHS = [
  /\/\.git\//,
  /\/\.env(\.|$|\s)/,
  /\/\.ssh\//,
  /\/\.gnupg\//,
  /\/\.aws\//,
  /\/id_rsa/,
  /\/\.npmrc/,
]

/**
 * Analyze a bash command for security risks.
 * Returns blocked=true for dangerous commands, warnings for suspicious ones.
 */
export function analyzeBashCommand(command: string): SecurityResult {
  const warnings: string[] = []

  // Check blocked patterns first
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, warnings: [], blocked: true, reason }
    }
  }

  // Check warning patterns
  for (const { pattern, warning } of WARNING_PATTERNS) {
    if (pattern.test(command)) {
      warnings.push(warning)
    }
  }

  // Check sensitive path access
  for (const pathPattern of SENSITIVE_PATHS) {
    if (pathPattern.test(command)) {
      warnings.push(`Accesses sensitive path: ${pathPattern.source}`)
    }
  }

  return {
    safe: warnings.length === 0,
    warnings,
    blocked: false
  }
}
