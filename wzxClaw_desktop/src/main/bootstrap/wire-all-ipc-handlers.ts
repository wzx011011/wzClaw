// ============================================================
// Bootstrap Stage 4 — wire-all-ipc-handlers
// 注册全部 IPC 通道，包含 workspace onWorkspaceOpened 回调（修复 indexingEngineRef 共享）
// ============================================================

import { ipcMain, BrowserWindow, Menu } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { EmbeddingClient } from '../indexing/embedding-client'
import { IndexingEngine } from '../indexing/indexing-engine'
import { registerAgentIpcHandlers } from '../agent/agent-ipc-handlers'
import { registerBrowserIpcHandlers } from '../browser/browser-ipc-handlers'
import { registerMobileIpcHandlers } from '../mobile/mobile-ipc-handlers'
import { registerHostHandlers } from '../hosts/host-ipc-handlers'
import { registerIpcHandlers } from '../ipc-handlers'
import type { CoreManagers } from './create-core-managers'
import type { InitialServices } from './init-services'

type WireAllDeps = CoreManagers & InitialServices

// ── 内部辅助：为给定工作区创建 IndexingEngine ─────────────────
function createIndexingEngineForWorkspace(
  rootPath: string,
  settingsManager: InitialServices['settingsManager'],
  logStartup: (label: string) => void
): IndexingEngine {
  const config = settingsManager.getCurrentConfig()
  const embeddingClient = new EmbeddingClient({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: 'text-embedding-3-small',
  })
  const engine = new IndexingEngine(rootPath, embeddingClient)
  if (embeddingClient.isConfigured()) {
    setTimeout(() => {
      engine.indexFull().catch((err) => console.error('[IndexingEngine] Initial indexing failed:', err))
    }, 15_000)
    logStartup('IndexingEngine scheduled (15s delay)')
  } else {
    console.log('[IndexingEngine] Embedding API not configured, skipping auto-index.')
  }
  return engine
}

// ── 内部辅助：workspace 打开时更新 indexingEngineRef 并联动工具 ──
function handleWorkspaceOpened(
  rootPath: string,
  deps: WireAllDeps,
  logStartup: (label: string) => void
): void {
  const { toolRegistry, settingsManager, indexingEngineRef } = deps

  // 清理旧 engine
  if (indexingEngineRef.current) {
    indexingEngineRef.current.dispose()
  }
  // 创建新 engine 并更新共享引用（IPC handlers 也会看到变化）
  indexingEngineRef.current = createIndexingEngineForWorkspace(rootPath, settingsManager, logStartup)

  // 更新 SemanticSearchTool 引用
  const searchTool = toolRegistry.get('SemanticSearch')
  if (searchTool && 'setIndexingEngine' in searchTool) {
    ;(searchTool as import('../tools/semantic-search').SemanticSearchTool).setIndexingEngine(
      indexingEngineRef.current
    )
  }

  // 索引进度 → renderer 转发
  indexingEngineRef.current.onProgress((progress) => {
    for (const bw of BrowserWindow.getAllWindows()) {
      bw.webContents.send(IPC_CHANNELS['index:progress'], progress)
    }
  })
}

export function wireAllIpcHandlers(
  deps: WireAllDeps,
  logStartup: (label: string) => void
): void {
  const {
    permissionManager, handBridge, planModeController, askUserTool, historyManager,
    mcpManager, toolRegistry, settingsManager, workspaceManager, terminalManager,
    workspaceStore, browserManager, indexingEngineRef,
    hostStore, sshCredentials, sshManager, sshExecutor, sshMonitor, sshSftp, sshDocker,
  } = deps

  // Agent IPC（ask-user / plan-mode / file-history）
  registerAgentIpcHandlers({
    askUserTool,
    planModeController,
    permissionManager,
    historyManager,
    getMainWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
  })

  // Browser + mobile IPC
  registerBrowserIpcHandlers({ browserManager })
  registerMobileIpcHandlers({ settingsManager })

  // Host (SSH) IPC — getMainWindow lazy-reads first window after creation
  registerHostHandlers({
    hostStore,
    sshManager,
    credentials: sshCredentials,
    executor: sshExecutor,
    monitor: sshMonitor,
    sftp: sshSftp,
    docker: sshDocker,
    getMainWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
    onDataChanged: undefined,
  })

  // 主域 IPC（workspace / terminal / index / settings / permission / MCP / hand）
  // 传入共享 indexingEngineRef 替代旧的 null — 修复 index:reindex 在 workspace 打开后的 stale ref 问题
  registerIpcHandlers(
    permissionManager,
    workspaceManager,
    terminalManager,
    indexingEngineRef,          // ← 共享引用，不再是初始 null 的快照
    settingsManager,
    mcpManager,
    workspaceStore,
    handBridge,
    toolRegistry,
    (rootPath) => {
      handleWorkspaceOpened(rootPath, deps, logStartup)
      settingsManager.setLastWorkspacePath(rootPath)
    },
    undefined,
    undefined
  )

  // 文件变更 → 增量索引
  workspaceManager.onFileChange((filePath: string, changeType: string) => {
    if (!indexingEngineRef.current) return
    if (changeType === 'deleted') {
      indexingEngineRef.current.removeFile(filePath).catch((err) =>
        console.error('[IndexingEngine] removeFile failed:', err)
      )
    } else {
      indexingEngineRef.current.indexFile(filePath).catch((err) =>
        console.error('[IndexingEngine] indexFile failed:', err)
      )
    }
  })

  // 隐藏原生菜单栏（使用自定义 titlebar）
  Menu.setApplicationMenu(null)

  // 主题 titlebar 颜色更新
  ipcMain.handle(
    IPC_CHANNELS['theme:set-titlebar-overlay'],
    (_event, payload: { color: string; symbolColor: string }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.setTitleBarOverlay({ color: payload.color, symbolColor: payload.symbolColor, height: 38 })
        } catch {
          // setTitleBarOverlay 在非 Windows 可能不可用
        }
      }
    }
  )
}
