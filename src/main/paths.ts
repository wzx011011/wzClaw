// ============================================================
// paths.ts — 中央路径管理模块
// 所有路径定义统一在此，避免分散在各模块中重复定义
// ============================================================

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { app } from 'electron'

// ---- 两个根目录 ----

/** 用户级根目录：~/.wzxclaw/（跨项目共享） */
export function getUserDir(): string {
  return path.join(os.homedir(), '.wzxclaw')
}

/** AppData 级根目录：%APPDATA%/wzxclaw/（应用数据，存 sessions/settings） */
export function getAppDataDir(): string {
  return app.getPath('userData')
}

// ---- 用户级子目录（~/.wzxclaw/） ----

/** 项目记忆目录：~/.wzxclaw/projects/{hash}/memory/ */
export function getProjectMemoryDir(workspaceRoot: string): string {
  const hash = sanitizePath(workspaceRoot)
  return path.join(getUserDir(), 'projects', hash, 'memory')
}

/** 任务级记忆目录：~/.wzxclaw/task-memory/{taskId}/ */
export function getTaskMemoryDir(taskId: string): string {
  return path.join(getUserDir(), 'task-memory', taskId)
}

/** 全局记忆文件：~/.wzxclaw/MEMORY.md（跨项目共享的个人偏好） */
export function getGlobalMemoryPath(): string {
  return path.join(getUserDir(), 'MEMORY.md')
}

/** MCP 配置文件：~/.wzxclaw/mcp.json */
export function getMcpConfigPath(): string {
  return path.join(getUserDir(), 'mcp.json')
}

/** 缓存目录：~/.wzxclaw/cache/ */
export function getCacheDir(): string {
  return path.join(getUserDir(), 'cache')
}

/** 调试日志目录：~/.wzxclaw/debug/ */
export function getDebugDir(): string {
  return path.join(getUserDir(), 'debug')
}

/** 用户自定义斜杠命令目录：~/.wzxclaw/commands/（只读扫描） */
export function getCommandsDir(): string {
  return path.join(getUserDir(), 'commands')
}

/** 用户自定义技能目录：~/.wzxclaw/skills/（只读扫描） */
export function getSkillsDir(): string {
  return path.join(getUserDir(), 'skills')
}

/** 用户自定义 agent 目录：~/.wzxclaw/agents/（只读扫描） */
export function getAgentsDir(): string {
  return path.join(getUserDir(), 'agents')
}

/** 粘贴缓存目录：~/.wzxclaw/paste-cache/ */
export function getPasteCacheDir(): string {
  return path.join(getUserDir(), 'paste-cache')
}

/** Shell 环境快照目录：~/.wzxclaw/shell-snapshots/ */
export function getShellSnapshotsDir(): string {
  return path.join(getUserDir(), 'shell-snapshots')
}

/** 截图媒体目录：~/.wzxclaw/media/（Browser 工具截图持久化，7 天自动清理） */
export function getMediaDir(): string {
  return path.join(getUserDir(), 'media')
}

/** 任务持久化目录：~/.wzxclaw/tasks/{hash}/ */
export function getTasksDir(workspaceRoot: string): string {
  const hash = sanitizePath(workspaceRoot)
  return path.join(getUserDir(), 'tasks', hash)
}

// ---- AppData 级子目录（%APPDATA%/wzxclaw/） ----

/**
 * 会话存储目录：%APPDATA%/wzxclaw/sessions/{projectHash}/
 * projectHash 由调用方传入（来自 workspace root）
 */
export function getSessionsDir(projectHash: string): string {
  return path.join(getAppDataDir(), 'sessions', projectHash)
}

/**
 * 任务级会话目录：%APPDATA%/wzxclaw/sessions/task-{taskId}/
 * 当 session 归属于 Task 时，使用 taskId 而非 workspace hash
 */
export function getTaskSessionsDir(taskId: string): string {
  return path.join(getAppDataDir(), 'sessions', `task-${taskId}`)
}

/** 设置文件备份目录：%APPDATA%/wzxclaw/backups/ */
export function getBackupsDir(): string {
  return path.join(getAppDataDir(), 'backups')
}

/** 设置文件路径：%APPDATA%/wzxclaw/settings.json */
export function getSettingsPath(): string {
  return path.join(getAppDataDir(), 'settings.json')
}

/** 加密密钥文件路径：%APPDATA%/wzxclaw/keys.enc */
export function getKeysPath(): string {
  return path.join(getAppDataDir(), 'keys.enc')
}

// ---- 工作区级（{workspace}/.wzxclaw/） ----

/** 代码索引目录：{workspace}/.wzxclaw/index/ */
export function getIndexDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.wzxclaw', 'index')
}

// ---- 工具函数 ----

/**
 * 将路径字符串转换为安全的目录名（MD5 前 12 位）。
 * 与 memory-manager.ts 中的散列逻辑保持一致。
 */
export function sanitizePath(p: string): string {
  return crypto.createHash('md5').update(p).digest('hex').slice(0, 12)
}

/**
 * 启动时批量创建所有固定目录（幂等）。
 * 首次运行时在 commands/ 和 skills/ 下写入 README.md 引导文件。
 */
export async function ensureAppDirs(): Promise<void> {
  const dirs = [
    // 用户级
    getCacheDir(),
    getDebugDir(),
    getPasteCacheDir(),
    getShellSnapshotsDir(),
    getCommandsDir(),
    getSkillsDir(),
    getMediaDir(),
    // AppData 级
    getBackupsDir(),
  ]
  await Promise.all(dirs.map(d => fs.mkdir(d, { recursive: true })))

  // 首次创建时写入引导 README（已存在不覆盖）
  await ensureReadme(
    path.join(getCommandsDir(), 'README.md'),
    `# 自定义指令 (Commands)

在此目录下放置 .md 文件，每次对话时会自动注入到 AI 上下文中。

## 示例

创建 \`git-commit-helper.md\`：

\`\`\`
当我请求提交代码时，始终使用 Conventional Commits 格式：
feat/fix/docs/style/refactor/test/chore(<scope>): <description>
\`\`\`

## 规则

- 文件名无限制，扩展名必须是 .md
- 所有文件内容会拼接后注入 system prompt
- 修改后重启对话即可生效
`
  )

  await ensureReadme(
    path.join(getSkillsDir(), 'README.md'),
    `# 自定义技能 (Skills)

在此目录下放置 .md 文件，定义可用斜杠命令调用的技能。

## 示例

创建 \`explain-regex.md\`：

\`\`\`
---
name: explain-regex
description: 解释正则表达式的含义
---

请逐步解释以下正则表达式的每个部分，并给出匹配示例。
\`\`\`

调用方式：在对话中输入 \`/explain-regex\` 即可触发。

## 规则

- 文件名无限制，扩展名必须是 .md
- 修改后重启对话即可生效
`
  )
}

/** 目标文件不存在时才写入（幂等首次引导） */
async function ensureReadme(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath)
    // 已存在，跳过
  } catch {
    await fs.writeFile(filePath, content, 'utf-8').catch(() => { /* ignore */ })
  }
}
