import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { WorkspaceManager } from '../workspace/workspace-manager'
import { SettingsManager } from '../settings-manager'

export interface SkillIpcDeps {
  workspaceManager: WorkspaceManager
  settingsManager: SettingsManager
  /** Resolves current workspace projectRoots (shared helper) */
  resolveProjectRoots: () => string[]
}

export function registerSkillIpcHandlers(deps: SkillIpcDeps): void {
  const { workspaceManager, settingsManager, resolveProjectRoots } = deps

  // ============================================================
  // Skills — list, get prompt, reload, invoke
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['skill:list'], async () => {
    const { skillRegistry } = await import('../skills')
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await skillRegistry.load(cwd, projectRoots)
    return skillRegistry.getAllInfo()
  })

  ipcMain.handle(IPC_CHANNELS['skill:get-prompt'], async (_event, request: { name: string; args: string }) => {
    const { skillRegistry } = await import('../skills')
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await skillRegistry.load(cwd, projectRoots)
    return skillRegistry.getPrompt(request.name, request.args ?? '', settingsManager.getLastSessionId() ?? 'unknown')
  })

  ipcMain.handle(IPC_CHANNELS['skill:reload'], async () => {
    const { skillRegistry } = await import('../skills')
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await skillRegistry.reload(cwd, projectRoots)
  })

  ipcMain.handle(IPC_CHANNELS['skill:invoke'], async (_event, request: { name: string; args: string }) => {
    const { skillRegistry } = await import('../skills')
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const projectRoots = resolveProjectRoots()
    await skillRegistry.load(cwd, projectRoots)
    const content = await skillRegistry.getPrompt(request.name, request.args ?? '', settingsManager.getLastSessionId() ?? 'unknown')
    if (content === null) {
      return { error: `Skill '${request.name}' not found` }
    }
    return { content }
  })
}
