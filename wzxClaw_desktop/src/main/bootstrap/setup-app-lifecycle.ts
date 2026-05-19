// ============================================================
// Bootstrap Stage 5 — setup-app-lifecycle
// 创建 BrowserWindow、注册 app 生命周期事件（before-quit / activate）
// ============================================================

import path from 'path'
import { app, BrowserWindow } from 'electron'
import { shutdownLangfuse } from '../observability/langfuse-observer'
import type { CoreManagers } from './create-core-managers'
import type { InitialServices } from './init-services'

type LifecycleDeps = CoreManagers & InitialServices & {
  logStartup: (label: string) => void
}

function createWindow(): BrowserWindow {
  const is = { dev: !app.isPackaged }

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false, // 等 ready-to-show 再显示，消除启动白屏
    backgroundColor: '#181818',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#181818',
      symbolColor: '#e0e0e0',
      height: 38,
    },
    webPreferences: {
      // electron-vite 打包到 out/main/index.js，__dirname = out/main/
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  // 窗口显示策略：ready-to-show 触发后立即显示
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    mainWindow.focus()
  })

  // 兜底：3s 未触发 ready-to-show 时强制显示
  const safetyShowTimer = setTimeout(() => {
    if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.warn('[STARTUP] ready-to-show 未触发，3s 后兜底显示窗口')
      mainWindow.show()
      mainWindow.focus()
    }
  }, 3000)
  mainWindow.once('show', () => clearTimeout(safetyShowTimer))
  mainWindow.once('closed', () => clearTimeout(safetyShowTimer))

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // dev 模式自动打开 DevTools
  if (is.dev) mainWindow.webContents.openDevTools({ mode: 'detach' })

  return mainWindow
}

export function setupAppLifecycle(deps: LifecycleDeps): void {
  const {
    permissionManager, settingsManager, indexingEngineRef,
    handBridge, terminalManager, workspaceManager, sshManager,
    browserManager, mcpManager, logStartup,
  } = deps

  // F12 打开 DevTools
  app.on('browser-window-created', (_, window) => {
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        window.webContents.toggleDevTools()
      }
    })
  })

  const mainWindow = createWindow()
  logStartup('BrowserWindow created')

  // 延迟加载：MCP 连接 + HandBridge 连接（不阻塞首帧）
  mainWindow.webContents.once('did-finish-load', () => {
    logStartup('renderer did-finish-load')
    setTimeout(() => {
      mcpManager.loadAndConnect().catch((err) =>
        console.error('[MCP] Failed to load and connect servers:', err)
      )
      logStartup('MCP loadAndConnect dispatched (deferred)')
    }, 300)
    setTimeout(() => {
      handBridge.connect()
      logStartup('HandBridge connect dispatched (deferred)')
    }, 300)
  })

  // macOS：所有窗口关闭后点击 Dock 图标重新打开
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // 退出前：保存状态 + 清理资源
  app.on('before-quit', () => {
    if (permissionManager) {
      settingsManager.saveAlwaysAllowRules(permissionManager.getAlwaysAllowRules())
    }
    settingsManager.flushSync()
    if (indexingEngineRef.current) {
      indexingEngineRef.current.dispose()
      indexingEngineRef.current = null
    }
    handBridge?.disconnect()
    terminalManager.dispose()
    workspaceManager.dispose()
    sshManager?.disconnectAll()
    browserManager.close().catch(() => {})
    shutdownLangfuse().catch(() => {})
  })
}
