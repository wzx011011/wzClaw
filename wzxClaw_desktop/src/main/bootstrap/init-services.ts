// ============================================================
// Bootstrap Stage 1 — init-services
// 初始化持久化服务：settings、workspace、terminal、browser，并做目录清理
// ============================================================

import fs from 'fs'
import { BrowserManager } from '../browser/browser-manager'
import { WorkspaceManager } from '../workspace/workspace-manager'
import { TerminalManager } from '../terminal/terminal-manager'
import { WorkspaceStore } from '../tasks/workspace-persistence'
import { SettingsManager } from '../settings-manager'
import { BackgroundTaskManager } from '../tasks/background-task-manager'
import { ensureAppDirs, ensureMcpConfig } from '../paths'
import { cleanOldDebugFiles, cleanOldMediaFiles } from '../utils/debug-logger'
import { cleanupExpiredToolResults } from '@wzxclaw/brain'
import { initLangfuse } from '../observability/langfuse-observer'

export interface InitialServices {
  settingsManager: SettingsManager
  workspaceManager: WorkspaceManager
  terminalManager: TerminalManager
  workspaceStore: WorkspaceStore
  browserManager: BrowserManager
  backgroundTaskManager: BackgroundTaskManager
}

export async function initServices(logStartup: (label: string) => void): Promise<InitialServices> {
  initLangfuse()

  const settingsManager = new SettingsManager()
  const workspaceManager = new WorkspaceManager()
  const terminalManager = new TerminalManager()
  const workspaceStore = new WorkspaceStore()
  const backgroundTaskManager = new BackgroundTaskManager()

  await ensureAppDirs()
  logStartup('ensureAppDirs done')
  await ensureMcpConfig()

  // 清理 7 天以上旧文件（一次性，非热路径）
  cleanOldDebugFiles().catch(() => {})
  cleanOldMediaFiles().catch(() => {})
  cleanupExpiredToolResults().catch(() => {})

  await settingsManager.load()
  logStartup('settingsManager loaded')

  // 恢复上次打开的工作区（不启动 watcher，等用户确认）
  const lastWsPath = settingsManager.getLastWorkspacePath()
  if (lastWsPath && fs.existsSync(lastWsPath)) {
    workspaceManager.setWorkspaceRoot(lastWsPath, { startWatching: false })
  }

  const browserManager = new BrowserManager()
  logStartup('services instantiated')

  return { settingsManager, workspaceManager, terminalManager, workspaceStore, browserManager, backgroundTaskManager }
}
