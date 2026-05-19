// ============================================================
// Index IPC Handlers — index:status/reindex/search/progress + git:status
// ============================================================

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { getGitStatusShort } from '../git/git-context'
import type { IndexingEngine } from '../indexing/indexing-engine'
import type { WorkspaceManager } from '../workspace/workspace-manager'

export interface IndexIpcDeps {
  workspaceManager: WorkspaceManager
  indexingEngineRef: { current: IndexingEngine | null }
}

export function registerIndexIpcHandlers(deps: IndexIpcDeps): void {
  const { workspaceManager, indexingEngineRef } = deps

  ipcMain.handle(IPC_CHANNELS['index:status'], () => {
    return indexingEngineRef.current?.getStatus() ?? { status: 'idle', fileCount: 0, currentFile: '' }
  })

  ipcMain.handle(IPC_CHANNELS['index:reindex'], async () => {
    if (!indexingEngineRef.current) throw new Error('No workspace open')
    await indexingEngineRef.current.indexFull()
  })

  ipcMain.handle(IPC_CHANNELS['index:search'], async (_event, request) => {
    if (!indexingEngineRef.current) return []
    return indexingEngineRef.current.search(request.query, request.topK)
  })

  // 注意：index:progress 转发在 wire-all-ipc-handlers 的 handleWorkspaceOpened 里设置，
  // 不应在此注册时设置（此时 indexingEngineRef.current 始终为 null）。

  ipcMain.handle(IPC_CHANNELS['git:status'], async () => {
    const cwd = workspaceManager.getWorkspaceRoot()
    if (!cwd) return { branch: '', changedFiles: 0 }
    return getGitStatusShort(cwd)
  })
}
