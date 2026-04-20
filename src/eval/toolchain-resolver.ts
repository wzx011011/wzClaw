// ============================================================
// 工具链检测 + PATH 补全 — 评测前自动检测语言运行时
// ============================================================

import { execSync } from 'child_process'
import { dirname, join } from 'path'
import { accessSync } from 'fs'

export interface ToolchainStatus {
  python: { available: boolean; command: string; version: string }
  go: { available: boolean; version: string }
  rust: { available: boolean; version: string }
  javascript: { available: boolean; version: string }
}

let status: ToolchainStatus | undefined

/**
 * 检测可用工具链，Windows 上自动补全 PATH。
 * 调用一次后缓存结果。修改 process.env.PATH。
 */
export function ensureToolchains(): ToolchainStatus {
  if (status) return status

  status = {
    python: { available: false, command: '', version: '' },
    go: { available: false, version: '' },
    rust: { available: false, version: '' },
    javascript: { available: true, version: process.version },
  }

  // Python: try python, python3, py in order
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const ver = execSync(`${cmd} --version`, { encoding: 'utf-8', timeout: 5000 }).trim()
      status.python = { available: true, command: cmd, version: ver }
      break
    } catch { /* not found */ }
  }

  // Go
  try {
    status.go.version = execSync('go version', { encoding: 'utf-8', timeout: 5000 }).trim()
    status.go.available = true
  } catch { /* not installed */ }

  // Rust (via cargo)
  try {
    status.rust.version = execSync('cargo --version', { encoding: 'utf-8', timeout: 5000 }).trim()
    status.rust.available = true
  } catch { /* not installed */ }

  // Windows: augment PATH so 'python' resolves
  if (process.platform === 'win32' && status.python.available && status.python.command !== 'python') {
    augmentPathForPython()
  }

  return status
}

function augmentPathForPython(): void {
  const additions: string[] = []

  try {
    const exePath = execSync(
      `${status!.python.command} -c "import sys; print(sys.executable)"`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim()
    if (exePath) {
      const pyDir = dirname(exePath)
      additions.push(pyDir)
      const scriptsDir = join(pyDir, 'Scripts')
      try { accessSync(scriptsDir); additions.push(scriptsDir) } catch { /* no Scripts */ }
    }
  } catch { /* cannot resolve */ }

  if (additions.length > 0) {
    process.env.PATH = [...additions, process.env.PATH ?? ''].join(';')
    status!.python.command = 'python' // now resolvable
  }
}

/**
 * 查询某语言工具链是否就绪（先调用 ensureToolchains）
 */
export function isToolchainAvailable(language: string): boolean {
  if (!status) ensureToolchains()
  switch (language) {
    case 'python': return status!.python.available
    case 'go': return status!.go.available
    case 'rust': return status!.rust.available
    case 'javascript': return status!.javascript.available
    default: return true
  }
}
