import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { LLMGateway } from './llm/gateway'
import { registerIpcHandlers } from './ipc-handlers'
import { createDefaultTools } from './tools/tool-registry'
import { PermissionManager } from './permission/permission-manager'
import { AgentLoop } from './agent/agent-loop'

const gateway = new LLMGateway()

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

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.wzxclaw')

  // Create tool registry with all default tools
  const workingDirectory = process.cwd() // Phase 3 adds workspace selection
  const toolRegistry = createDefaultTools(workingDirectory)
  const permissionManager = new PermissionManager()
  const agentLoop = new AgentLoop(gateway, toolRegistry, permissionManager)

  // Wire IPC handlers with all components
  registerIpcHandlers(gateway, agentLoop, permissionManager)

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
