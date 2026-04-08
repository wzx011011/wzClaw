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

const gateway = new LLMGateway()
const workspaceManager = new WorkspaceManager()

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.wzxclaw')

  // Create tool registry with workspace root when available
  const workingDirectory = workspaceManager.getWorkspaceRoot() ?? process.cwd()
  const toolRegistry = createDefaultTools(workingDirectory)
  const permissionManager = new PermissionManager()
  const contextManager = new ContextManager()
  const agentLoop = new AgentLoop(gateway, toolRegistry, permissionManager, contextManager)

  // Create session store for JSONL persistence (per PERSIST-01)
  const sessionStore = new SessionStore(workspaceManager.getWorkspaceRoot() ?? process.cwd())

  // Wire IPC handlers with all components including workspace manager, session store, and context manager
  registerIpcHandlers(gateway, agentLoop, permissionManager, workspaceManager, sessionStore, contextManager)

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
  workspaceManager.dispose()
})
