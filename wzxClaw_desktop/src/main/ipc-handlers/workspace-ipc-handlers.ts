// ============================================================
// Workspace IPC Handlers — workspace:* + shell:open_path/get_extension_paths + todo:load
// ============================================================

import { ipcMain, BrowserWindow, shell } from 'electron'
import path from 'path'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { getCommandsDir, getSkillsDir } from '../paths'
import { invalidateGitCache } from '../git/git-context'
import type { WorkspaceManager } from '../workspace/workspace-manager'
import type { WorkspaceStore } from '../tasks/workspace-persistence'

export interface WorkspaceIpcDeps {
  workspaceManager: WorkspaceManager
  workspaceStore: WorkspaceStore
  onWorkspaceOpened?: (rootPath: string) => void
  onDataChanged?: (event: string, data: unknown) => void
}

export function registerWorkspaceIpcHandlers(deps: WorkspaceIpcDeps): void {
  const { workspaceManager, workspaceStore, onWorkspaceOpened, onDataChanged } = deps

  let fileChangeUnsubscribe: (() => void) | null = null

  function forwardFileChanges(): void {
    const callback = (filePath: string, changeType: string) => {
      invalidateGitCache()
      for (const bw of BrowserWindow.getAllWindows()) {
        bw.webContents.send(IPC_CHANNELS['file:changed'], { filePath, changeType })
      }
    }
    workspaceManager.onFileChange(callback)
    fileChangeUnsubscribe = () => {
      workspaceManager.offFileChange(callback)
    }
  }

  ipcMain.handle(IPC_CHANNELS['workspace:open_folder'], async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null

    const rootPath = await workspaceManager.openFolderDialog(win)
    if (rootPath) {
      if (fileChangeUnsubscribe) {
        fileChangeUnsubscribe()
        fileChangeUnsubscribe = null
      }
      forwardFileChanges()
      onWorkspaceOpened?.(rootPath)
      return { rootPath }
    }
    return null
  })

  ipcMain.handle(IPC_CHANNELS['workspace:set_folder'], async (_event, { folderPath }: { folderPath: string }) => {
    const rootPath = await workspaceManager.setFolder(folderPath)
    if (rootPath) {
      if (fileChangeUnsubscribe) {
        fileChangeUnsubscribe()
        fileChangeUnsubscribe = null
      }
      forwardFileChanges()
      onWorkspaceOpened?.(rootPath)
      return { rootPath }
    }
    return null
  })

  ipcMain.handle(IPC_CHANNELS['shell:open_path'], async (_event, { path: folderPath }) => {
    const allowed = [getCommandsDir(), getSkillsDir()]
    const resolved = path.resolve(String(folderPath ?? '')).toLowerCase()
    const isAllowed = allowed.some(d => resolved === d.toLowerCase() || resolved.startsWith(d.toLowerCase() + path.sep))
    if (!isAllowed) {
      throw new Error('shell:open_path blocked: path not in allowed extension directories')
    }
    await shell.openPath(resolved)
  })

  ipcMain.handle(IPC_CHANNELS['shell:get_extension_paths'], () => {
    return { commandsDir: getCommandsDir(), skillsDir: getSkillsDir() }
  })

  ipcMain.handle(IPC_CHANNELS['workspace:get_tree'], async (_event, request) => {
    return workspaceManager.getDirectoryTree(request?.dirPath, request?.depth)
  })

  ipcMain.handle(IPC_CHANNELS['workspace:watch'], async () => {
    await workspaceManager.startWatching()
  })

  ipcMain.handle(IPC_CHANNELS['workspace:status'], () => {
    return {
      rootPath: workspaceManager.getWorkspaceRoot(),
      isWatching: workspaceManager.isWatching()
    }
  })

  ipcMain.handle(IPC_CHANNELS['todo:load'], async (_event, request: { sessionId: string }) => {
    const { TodoWriteTool } = await import('../tools/todo-write')
    const todos = await TodoWriteTool.loadForSession(request.sessionId)
    return todos.map(t => ({ content: t.content, status: t.status, activeForm: t.activeForm ?? '' }))
  })

  // ---- Workspace CRUD ----
  ipcMain.handle(IPC_CHANNELS['workspace:list'], async (_event, payload?: { includeArchived?: boolean }) => {
    return workspaceStore.listWorkspaces(payload?.includeArchived)
  })

  ipcMain.handle(IPC_CHANNELS['workspace:get'], async (_event, payload: { workspaceId: string }) => {
    return workspaceStore.getWorkspace(payload.workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS['workspace:create'], async (_event, payload: { title: string; description?: string }) => {
    const workspace = await workspaceStore.createWorkspace(payload.title, payload.description)
    onDataChanged?.('workspace:changed', { action: 'created', workspace })
    return workspace
  })

  ipcMain.handle(IPC_CHANNELS['workspace:update'], async (_event, payload: { workspaceId: string; updates: { title?: string; description?: string; archived?: boolean; lastSessionId?: string } }) => {
    const workspace = await workspaceStore.updateWorkspace(payload.workspaceId, payload.updates)
    onDataChanged?.('workspace:changed', { action: 'updated', workspace })
    return workspace
  })

  ipcMain.handle(IPC_CHANNELS['workspace:delete'], async (_event, payload: { workspaceId: string }) => {
    await workspaceStore.deleteWorkspace(payload.workspaceId)
    onDataChanged?.('workspace:changed', { action: 'deleted', workspaceId: payload.workspaceId })
  })

  ipcMain.handle(IPC_CHANNELS['workspace:add-project'], async (_event, payload: { workspaceId: string; folderPath: string }) => {
    const workspace = await workspaceStore.addProject(payload.workspaceId, payload.folderPath)
    onDataChanged?.('workspace:changed', { action: 'updated', workspace })
    return workspace
  })

  ipcMain.handle(IPC_CHANNELS['workspace:remove-project'], async (_event, payload: { workspaceId: string; projectId: string }) => {
    const workspace = await workspaceStore.removeProject(payload.workspaceId, payload.projectId)
    onDataChanged?.('workspace:changed', { action: 'updated', workspace })
    return workspace
  })
}
