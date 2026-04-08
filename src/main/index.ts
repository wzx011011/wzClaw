import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { LLMGateway } from './llm/gateway'
import { registerIpcHandlers } from './ipc-handlers'
import { createDefaultTools } from './tools/tool-registry'
import { PermissionManager } from './permission/permission-manager'
import { AgentLoop } from './agent/agent-loop'
import { WorkspaceManager } from './workspace/workspace-manager'
import { SessionStore } from './persistence/session-store'
import { ContextManager } from './context/context-manager'
import { TerminalManager } from './terminal/terminal-manager'
import { TaskManager } from './tasks/task-manager'
import { CreateTaskTool } from './tools/create-task'
import { UpdateTaskTool } from './tools/update-task'
import { IndexingEngine } from './indexing/indexing-engine'
import { EmbeddingClient } from './indexing/embedding-client'
import { SettingsManager } from './settings-manager'
import { ToolRegistry } from './tools/tool-registry'
import { IPC_CHANNELS } from '../shared/ipc-channels'

const gateway = new LLMGateway()
const workspaceManager = new WorkspaceManager()
const terminalManager = new TerminalManager()
const taskManager = new TaskManager()

// Module-level IndexingEngine reference (created when workspace opens)
let indexingEngine: IndexingEngine | null = null

// Persistent settings for embedding API configuration
const settingsManager = new SettingsManager()

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#181818',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#181818',
      symbolColor: '#e0e0e0',
      height: 38
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

function buildMenuBar(): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: (_menuItem, browserWindow) => {
            if (browserWindow) {
              // Trigger the same IPC flow as the sidebar button
              browserWindow.webContents.executeJavaScript('window.wzxclaw.openFolder()')
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: (_menuItem, browserWindow) => {
            if (browserWindow) {
              browserWindow.webContents.send('file:save_request')
            }
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}

/**
 * Create an IndexingEngine for a given workspace root.
 * Uses the current settings to configure the EmbeddingClient.
 */
function createIndexingEngineForWorkspace(rootPath: string): IndexingEngine {
  const config = settingsManager.getCurrentConfig()
  const embeddingClient = new EmbeddingClient({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: 'text-embedding-3-small'
  })
  const engine = new IndexingEngine(rootPath, embeddingClient)
  // Start full indexing in background
  engine.indexFull().catch((err) => console.error('[IndexingEngine] Initial indexing failed:', err))
  return engine
}

/**
 * Callback invoked by IPC handlers when a workspace is opened.
 * Creates IndexingEngine and updates SemanticSearchTool.
 */
function handleWorkspaceOpened(rootPath: string, toolRegistry: ToolRegistry): void {
  // Dispose old engine
  if (indexingEngine) {
    indexingEngine.dispose()
  }
  // Create new indexing engine for the opened workspace
  indexingEngine = createIndexingEngineForWorkspace(rootPath)

  // Update SemanticSearchTool with the new engine
  const searchTool = toolRegistry.get('SemanticSearch')
  if (searchTool && 'setIndexingEngine' in searchTool) {
    ;(searchTool as any).setIndexingEngine(indexingEngine)
  }

  // Forward indexing progress to all renderer windows
  indexingEngine.onProgress((progress) => {
    for (const bw of BrowserWindow.getAllWindows()) {
      bw.webContents.send(IPC_CHANNELS['index:progress'], progress)
    }
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.wzxclaw')

  // Load persisted settings for embedding API config
  settingsManager.load()

  // Create tool registry with workspace root when available
  const workingDirectory = workspaceManager.getWorkspaceRoot() ?? process.cwd()
  const getWebContents = () => BrowserWindow.getAllWindows()[0]?.webContents ?? null
  const toolRegistry = createDefaultTools(workingDirectory, terminalManager, getWebContents, taskManager, indexingEngine)
  const permissionManager = new PermissionManager()
  const contextManager = new ContextManager()
  const agentLoop = new AgentLoop(gateway, toolRegistry, permissionManager, contextManager)

  // Create session store for JSONL persistence (per PERSIST-01)
  const sessionStore = new SessionStore(workspaceManager.getWorkspaceRoot() ?? process.cwd())

  // Wire IPC handlers with all components including indexing engine.
  // Pass a callback so IPC handlers can notify when workspace opens.
  registerIpcHandlers(
    gateway, agentLoop, permissionManager, workspaceManager, sessionStore,
    contextManager, terminalManager, taskManager, indexingEngine,
    (rootPath) => handleWorkspaceOpened(rootPath, toolRegistry)
  )

  // Listen for file changes to trigger incremental index updates
  workspaceManager.onFileChange((filePath: string, changeType: string) => {
    if (!indexingEngine) return
    if (changeType === 'deleted') {
      indexingEngine.removeFile(filePath).catch((err) =>
        console.error('[IndexingEngine] removeFile failed:', err)
      )
    } else {
      indexingEngine.indexFile(filePath).catch((err) =>
        console.error('[IndexingEngine] indexFile failed:', err)
      )
    }
  })

  // Set up Chromium menu bar
  Menu.setApplicationMenu(buildMenuBar())

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  createWindow()
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  // Dispose indexing engine
  if (indexingEngine) {
    indexingEngine.dispose()
    indexingEngine = null
  }
  terminalManager.dispose()
  workspaceManager.dispose()
})
