import { app, BrowserWindow, Menu, ipcMain } from 'electron'
import { join } from 'path'
import { networkInterfaces } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { LLMGateway } from './llm/gateway'
import { registerIpcHandlers } from './ipc-handlers'
import { createDefaultTools } from './tools/tool-registry'
import { AgentTool } from './tools/agent-tool'
import { PermissionManager } from './permission/permission-manager'
import { AgentLoop } from './agent/agent-loop'
import type { AgentConfig } from './agent/types'
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
import { BrowserManager } from './browser/browser-manager'
import {
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserScreenshotTool,
  BrowserEvaluateTool,
  BrowserCloseTool
} from './tools/browser-tools'
import { MobileServer } from './mobile/mobile-server'
import { TunnelManager } from './mobile/tunnel-manager'
import { generateQRCode } from './mobile/qr-generator'

const gateway = new LLMGateway()
const workspaceManager = new WorkspaceManager()
const terminalManager = new TerminalManager()
const taskManager = new TaskManager()
const browserManager = new BrowserManager()
const mobileServer = new MobileServer()
const tunnelManager = new TunnelManager()

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
    backgroundColor: '#00000000',
    transparent: true,
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

  // Register AgentTool (sub-agent) — must be after registry + agentLoop deps exist
  toolRegistry.register(
    new AgentTool(gateway, toolRegistry, permissionManager, contextManager, undefined, {
      provider: 'anthropic' as any,
      model: '',
      workingDirectory
    })
  )

  // Register browser automation tools
  toolRegistry.register(new BrowserNavigateTool(browserManager))
  toolRegistry.register(new BrowserClickTool(browserManager))
  toolRegistry.register(new BrowserTypeTool(browserManager))
  toolRegistry.register(new BrowserScreenshotTool(browserManager))
  toolRegistry.register(new BrowserEvaluateTool(browserManager))
  toolRegistry.register(new BrowserCloseTool(browserManager))

  // Forward browser events to renderer
  browserManager.on('screenshot', (data) => {
    for (const bw of BrowserWindow.getAllWindows()) {
      bw.webContents.send(IPC_CHANNELS['browser:screenshot'], data)
    }
  })
  browserManager.on('status', (data) => {
    for (const bw of BrowserWindow.getAllWindows()) {
      bw.webContents.send(IPC_CHANNELS['browser:status'], data)
    }
  })

  // Forward mobile server status to renderer
  mobileServer.on('status', (data) => {
    for (const bw of BrowserWindow.getAllWindows()) {
      bw.webContents.send(IPC_CHANNELS['mobile:status'], data)
    }
  })

  // Handle mobile client commands → agent
  mobileServer.on('client-message', async (msg: { clientId: string; event: string; data: any }) => {
    if (msg.event === 'command:send' && msg.data?.content) {
      // Build agent config from current settings
      const config = settingsManager.getCurrentConfig()
      const agentConfig: AgentConfig = {
        model: config.model,
        provider: config.provider as 'openai' | 'anthropic',
        systemPrompt: config.systemPrompt,
        workingDirectory,
        conversationId: 'mobile',
      }
      try {
        for await (const agentEvent of agentLoop.run(msg.data.content, agentConfig)) {
          // Forward stream events to both renderer and mobile clients
          const wc = BrowserWindow.getAllWindows()[0]?.webContents
          if (wc) {
            switch (agentEvent.type) {
              case 'agent:text':
                wc.send(IPC_CHANNELS['stream:text_delta'], { content: agentEvent.content })
                break
              case 'agent:tool_call':
                wc.send(IPC_CHANNELS['stream:tool_use_start'], { id: agentEvent.toolCallId, name: agentEvent.toolName })
                break
              case 'agent:tool_result':
                wc.send(IPC_CHANNELS['stream:tool_use_end'], { id: agentEvent.toolCallId, output: agentEvent.output, isError: agentEvent.isError, toolName: agentEvent.toolName })
                break
              case 'agent:error':
                wc.send(IPC_CHANNELS['stream:error'], { error: agentEvent.error })
                break
              case 'agent:done':
                wc.send(IPC_CHANNELS['stream:done'], { usage: agentEvent.usage })
                break
            }
          }
          mobileServer.broadcast(`stream:${agentEvent.type}`, agentEvent)
        }
      } catch (err: any) {
        mobileServer.broadcast('stream:error', { error: err.message })
      }
    } else if (msg.event === 'command:stop') {
      agentLoop.cancel()
    }
  })

  // Register browser + mobile IPC handlers

  // Browser control handlers (renderer -> main)
  ipcMain.handle(IPC_CHANNELS['browser:navigate'], async (_e: unknown, request: { url: string }) => {
    const title = await browserManager.navigate(request.url)
    return { title }
  })

  ipcMain.handle(IPC_CHANNELS['browser:take_screenshot'], async () => {
    const base64 = await browserManager.screenshot()
    return { base64 }
  })

  ipcMain.handle(IPC_CHANNELS['browser:close'], async () => {
    await browserManager.close()
  })

  // Mobile handlers
  ipcMain.handle(IPC_CHANNELS['mobile:start'], async () => {
    const { port, token } = await mobileServer.start()

    // Get LAN IP for QR code
    const nets = networkInterfaces()
    let lanIp = 'localhost'
    for (const ifaces of Object.values(nets) as any[]) {
      for (const iface of ifaces) {
        if (iface.family === 'IPv4' && !iface.internal) {
          lanIp = iface.address
          break
        }
      }
      if (lanIp !== 'localhost') break
    }

    const localUrl = `http://${lanIp}:${port}?token=${token}`

    // Generate LAN QR code (always available)
    const lanQrCode = await generateQRCode(localUrl)

    // Try to create tunnel for WAN access
    let tunnelUrl: string | null = null
    let tunnelQrCode: string | null = null
    let tunnelError: string | null = null
    try {
      const rawTunnelUrl = await tunnelManager.open(port)
      tunnelUrl = `${rawTunnelUrl}?token=${token}`
      tunnelQrCode = await generateQRCode(tunnelUrl)
    } catch (err: any) {
      tunnelError = err.message
      console.warn('[TunnelManager] Failed to create tunnel:', err.message)
    }

    return { lanQrCode, tunnelQrCode, localUrl, tunnelUrl, tunnelError }
  })

  ipcMain.handle(IPC_CHANNELS['mobile:stop'], async () => {
    await tunnelManager.close()
    await mobileServer.stop()
  })

  // Create session store for JSONL persistence (per PERSIST-01)
  const sessionStore = new SessionStore(workspaceManager.getWorkspaceRoot() ?? process.cwd())

  // Wire IPC handlers with all components including indexing engine.
  // Pass a callback so IPC handlers can notify when workspace opens.
  registerIpcHandlers(
    gateway, agentLoop, permissionManager, workspaceManager, sessionStore,
    contextManager, terminalManager, taskManager, indexingEngine, settingsManager,
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
  browserManager.close().catch(() => {})
  tunnelManager.close().catch(() => {})
  mobileServer.stop().catch(() => {})
})
