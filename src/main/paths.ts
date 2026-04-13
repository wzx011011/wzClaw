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

// ---- AppData 级子目录（%APPDATA%/wzxclaw/） ----

/**
 * 会话存储目录：%APPDATA%/wzxclaw/sessions/{projectHash}/
 * projectHash 由调用方传入（来自 workspace root）
 */
export function getSessionsDir(projectHash: string): string {
  return path.join(getAppDataDir(), 'sessions', projectHash)
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
 * commands/skills/agents 不自动创建，用户手动建立后才生效。
 */
export async function ensureAppDirs(): Promise<void> {
  const dirs = [
    // 用户级
    getCacheDir(),
    getDebugDir(),
    getPasteCacheDir(),
    getShellSnapshotsDir(),
    // AppData 级
    getBackupsDir(),
  ]
  await Promise.all(dirs.map(d => fs.mkdir(d, { recursive: true })))
}
