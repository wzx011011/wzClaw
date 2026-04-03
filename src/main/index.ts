import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { LLMGateway } from './llm/gateway'
import { registerIpcHandlers } from './ipc-handlers'
import { createDefaultTools } from './tools/tool-registry'
import { PermissionManager } from './permission/permission-manager'
import { AgentLoop } from './agent/agent-loop'
import { WorkspaceManager } from './workspace/workspace-manager'

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
              browserWindow.webContents.send('workspace:open_folder')
              // Trigger the IPC handler by having the renderer invoke it
              // The menu click directly calls the workspace manager
              workspaceManager.openFolderDialog(browserWindow).then((rootPath) => {
                if (rootPath) {
                  // Set up file change forwarding
                  workspaceManager.onFileChange((filePath, changeType) => {
                    for (const bw of BrowserWindow.getAllWindows()) {
                      bw.webContents.send('file:changed', { filePath, changeType })
                    }
                  })
                  // Notify renderer of the opened folder
                  browserWindow.webContents.send('workspace:folder_opened', { rootPath })
                }
              })
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
  const agentLoop = new AgentLoop(gateway, toolRegistry, permissionManager)

  // Wire IPC handlers with all components including workspace manager
  registerIpcHandlers(gateway, agentLoop, permissionManager, workspaceManager)

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
