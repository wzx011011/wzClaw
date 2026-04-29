// ============================================================
// 工作空间隔离 — 为每个评测工作区创建独立的临时工作目录
// ============================================================

import { mkdir, writeFile, rm } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import type { BenchmarkTask } from './types'

const execAsync = promisify(execFile)

const DEFAULT_BASE_DIR = path.join(process.cwd(), '.eval-workspaces')

export interface IsolatedWorkspace {
  workspaceDir: string
  cleanup: () => Promise<void>
}

/**
 * 为一个评测工作区准备隔离的工作空间
 * 1. 创建临时目录
 * 2. 写入起始代码文件
 * 3. git init + commit（让 system-prompt-builder 的 git context 正常工作）
 */
export async function prepareWorkspace(
  task: BenchmarkTask,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<IsolatedWorkspace> {
  const workspaceDir = path.join(baseDir, `task-${task.id}-${Date.now()}`)
  await mkdir(workspaceDir, { recursive: true })

  // 写入起始文件
  for (const [relativePath, content] of Object.entries(task.startingFiles)) {
    const filePath = path.join(workspaceDir, relativePath)
    const dir = path.dirname(filePath)
    await mkdir(dir, { recursive: true })
    await writeFile(filePath, content, 'utf-8')
  }

  // git init（system-prompt-builder 会读取 git context）
  try {
    await execAsync('git', ['init'], { cwd: workspaceDir })
    await execAsync('git', ['add', '-A'], { cwd: workspaceDir })
    await execAsync('git', ['commit', '-m', 'initial state', '--no-gpg-sign'], {
      cwd: workspaceDir,
      env: { ...process.env, GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@wzxclaw.dev', GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@wzxclaw.dev' },
    })
  } catch {
    // git init 失败不阻塞评测（只是 git context 不可用）
  }

  return {
    workspaceDir,
    cleanup: () => rm(workspaceDir, { recursive: true, force: true }),
  }
}

/**
 * 从工作空间提取 git diff（agent 的修改）
 */
export async function extractPatch(workspaceDir: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git', ['diff'], { cwd: workspaceDir })
    return stdout
  } catch {
    return ''
  }
}
