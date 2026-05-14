import { config as dotenvConfig } from 'dotenv'
import path from 'path'
// Explicitly resolve .env from project root (cwd is unreliable in packaged Electron)
const _envResult = dotenvConfig({ path: path.resolve(__dirname, '../../.env') })
if (_envResult.error) {
  console.warn('[dotenv] .env not loaded:', _envResult.error.message)
} else {
  console.log('[dotenv] loaded, LANGFUSE_PUBLIC_KEY=', process.env.LANGFUSE_PUBLIC_KEY?.slice(0, 10) + '...')
}

import { app, BrowserWindow, Menu, ipcMain } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
const { join } = path

// ── Windows 拖拽卡顿修复 ────────────────────────────────────────────
// `CalculateNativeWinOcclusion` 是 Chromium 在 Windows 上的窗口遮挡探测特性，
// 实测会让主线程在窗口拖动 / 长时间运行后周期性 stall，表现为「拖拽卡顿、窗
// 口无响应几百毫秒」。Electron 官方 issue 已多次记录，禁用后体感明显流畅。
// 同时关闭硬件媒体键处理（与本应用无关，但偶发后台占用）。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,HardwareMediaKeyHandling')

// Ignore EPIPE errors on stdout/stderr — happens when Electron is launched from
// a pipe (e.g. Claude Code hook) and the parent process exits while async
// console.warn / console.log are still writing.
process.stdout.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err })
process.stderr.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err })
// Inline replacements for @electron-toolkit/utils (v4 CJS compat issue)
const is = { dev: !app.isPackaged }
const electronApp = {
  setAppUserModelId(id: string) {
    if (is.dev) { app.setAppUserModelId(process.execPath) }
    else { app.setAppUserModelId(id) }
  }
}
const optimizer = {
  watchWindowShortcuts(win: BrowserWindow) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools()
      }
    })
  }
}
import { LLMGateway } from './llm/gateway'
import { registerIpcHandlers } from './ipc-handlers'
import { HostStore } from './hosts/host-store'
import { SshCredentials } from './hosts/ssh-credentials'
import { SshManager } from './hosts/ssh-manager'
import { SshExecutor } from './hosts/ssh-executor'
import { SshMonitor } from './hosts/ssh-monitor'
import { SshSftp } from './hosts/ssh-sftp'
import { SshDocker } from './hosts/ssh-docker'
import { registerHostHandlers } from './hosts/host-ipc-handlers'
import { createDefaultTools } from './tools/tool-registry'
import { BackgroundTaskManager } from './tasks/background-task-manager'
import { NotificationService } from './notification/notification-service'
import { AgentTool } from './tools/agent-tool'
import { PermissionManager } from './permission/permission-manager'
import { createDesktopAgentLoop } from './brain-bridge'
import { SessionRuntimeManager } from './agent/session-runtime-manager'
import { SessionTaskStateManager, isActiveSessionTaskStatus } from './agent/session-task-state-manager'
import type { AgentConfig } from './agent/types'
import { WorkspaceManager } from './workspace/workspace-manager'
import { SessionStore, type SessionMeta } from './persistence/session-store'
import { SessionStoreManager } from './persistence/session-store-manager'
import { ContextManager } from './context/context-manager'
import { TerminalManager } from './terminal/terminal-manager'
import { StepManager } from './steps/step-manager'
import { WorkspaceStore } from './tasks/workspace-store'
import { HookRegistry } from './hooks/hook-registry'
import { registerBuiltInHooks } from './hooks/built-in-hooks'
import { IndexingEngine } from './indexing/indexing-engine'
import { EmbeddingClient } from './indexing/embedding-client'
import { SettingsManager } from './settings-manager'
import { ToolRegistry } from './tools/tool-registry'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { DEFAULT_MODELS } from '../shared/constants'
import { BrowserManager } from './browser/browser-manager'
import { MCPManager } from './mcp/mcp-manager'
import { PlanModeController, EnterPlanModeTool, ExitPlanModeTool } from './tools/plan-mode'
import { FileHistoryManager } from './file-history/file-history-manager'
import { AskUserQuestionTool } from './tools/ask-user'
import type { AskUserAnswer } from './tools/ask-user'
import {
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserScreenshotTool,
  BrowserEvaluateTool,
  BrowserCloseTool
} from './tools/browser-tools'
import { RelayClient } from './mobile/relay-client'
import { registerAgentIpcHandlers } from './agent/agent-ipc-handlers'
import { registerBrowserIpcHandlers } from './browser/browser-ipc-handlers'
import { registerMobileIpcHandlers } from './mobile/mobile-ipc-handlers'
import { registerMobileRelayHandler } from './mobile/mobile-relay-handler'
import { getMobileSessionTransition, isPathWithinWorkspace } from './mobile/mobile-session-utils'
import { ensureAppDirs, ensureMcpConfig } from './paths'
import { cleanOldDebugFiles, cleanOldMediaFiles } from './utils/debug-logger'
import { initLangfuse, shutdownLangfuse } from './observability/langfuse-observer'
import { cleanupToolResults, cleanupExpiredToolResults } from './context/tool-result-storage'

const gateway = new LLMGateway()
const workspaceManager = new WorkspaceManager()
const terminalManager = new TerminalManager()
const stepManager = new StepManager()
const workspaceStore = new WorkspaceStore()
// These services are initialized lazily inside app.whenReady() to speed up startup
let browserManager!: BrowserManager
let relayClient!: RelayClient

// Module-level IndexingEngine reference (created when workspace opens)
let indexingEngine: IndexingEngine | null = null

// Module-level PermissionManager (needed in before-quit handler)
let permissionManager: PermissionManager | null = null

// Persistent settings for embedding API configuration
const settingsManager = new SettingsManager()

// Module-level SSH service references (needed in before-quit handler)
let sshCredentials: import('./hosts/ssh-credentials').SshCredentials | null = null
let sshManager: import('./hosts/ssh-manager').SshManager | null = null

// ── Startup diagnostics ────────────────────────────────────────────────────
const _t0 = Date.now()
const logStartup = (label: string) => console.log(`[STARTUP] +${Date.now() - _t0}ms  ${label}`)

// NOTE: Single-instance lock REMOVED — suspected cause of "Not Responding" freeze.
// app.requestSingleInstanceLock() may interact with GPU/cache mutex on Windows
// and cause periodic main-thread stalls. Re-enable with a different strategy if
// multi-instance prevention is needed later.

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false, // 等 ready-to-show 再显示，消除启动时白屏闪烁
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

  // 窗口显示策略：splash drag div 在 index.html 内联脚本里同步注入，
  // Chromium 在 ready-to-show 前已完成 hit-test 区域缓存，
  // 因此不再需要等待 renderer IPC 回报 —— 直接在 ready-to-show 时显示窗口。
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    mainWindow.focus()
  })

  // 兜底：ready-to-show 超 3s 未触发时强制显示（避免白屏）
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
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // DEBUG: auto-open DevTools to catch renderer errors (dev mode only)
  if (is.dev) mainWindow.webContents.openDevTools({ mode: 'detach' })

  return mainWindow
}

function _buildMenuBar(): Menu {
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
              browserWindow.webContents.send(IPC_CHANNELS['file:save_request'])
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
 */
function createIndexingEngineForWorkspace(rootPath: string): IndexingEngine {
  const config = settingsManager.getCurrentConfig()
  const embeddingClient = new EmbeddingClient({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: 'text-embedding-3-small'
  })
  const engine = new IndexingEngine(rootPath, embeddingClient)
  // Only auto-index if embedding API is configured
  // Delay 15s so the UI is fully interactive before indexing starts
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
    ;(searchTool as import('./tools/semantic-search').SemanticSearchTool).setIndexingEngine(indexingEngine)
  }

  // Forward indexing progress to all renderer windows
  indexingEngine.onProgress((progress) => {
    for (const bw of BrowserWindow.getAllWindows()) {
      bw.webContents.send(IPC_CHANNELS['index:progress'], progress)
    }
  })
}

app.whenReady().then(async () => {
  logStartup('app.whenReady fired')
  initLangfuse()
  electronApp.setAppUserModelId('com.wzxclaw')

  // 创建所有运行时所需目录（cache/debug/paste-cache/shell-snapshots/backups）
  await ensureAppDirs()
  logStartup('ensureAppDirs done')
  // 首次运行创建默认 MCP 配置（幂等，不覆盖）
  await ensureMcpConfig()
  // 清理 7 天以上的旧文件（一次性，非热路径）
  cleanOldDebugFiles().catch(() => {})
  cleanOldMediaFiles().catch(() => {})
  cleanupExpiredToolResults().catch(() => {})

  // Load persisted settings for embedding API config
  await settingsManager.load()
  logStartup('settingsManager loaded')

  // Initialize deferred services (after app is ready, before window creation)
  browserManager = new BrowserManager()
  relayClient = new RelayClient()
  logStartup('services instantiated')

  // Restore last workspace if saved
  const lastWsPath = settingsManager.getLastWorkspacePath()
  if (lastWsPath && fs.existsSync(lastWsPath)) {
    workspaceManager.setWorkspaceRoot(lastWsPath, { startWatching: false })
  }

  // relay connect 推迟到 did-finish-load 后执行 — 不阻塞启动链
  // 保存 token 供 did-finish-load 回调使用
  const savedRelayToken = settingsManager.getRelayToken()
  logStartup('relay connect deferred to did-finish-load')

  // Create tool registry with workspace root when available
  const workingDirectory = workspaceManager.getWorkspaceRoot() ?? process.cwd()
  const getWebContents = () => BrowserWindow.getAllWindows()[0]?.webContents ?? null
  const backgroundTaskManager = new BackgroundTaskManager()
  const notificationService = new NotificationService()
  const toolRegistry = createDefaultTools(workingDirectory, terminalManager, getWebContents, stepManager, indexingEngine, backgroundTaskManager)
  permissionManager = new PermissionManager()
  // Load persisted alwaysAllow rules from previous sessions
  permissionManager.loadAlwaysAllowRules(settingsManager.getAlwaysAllowRules())
  const contextManager = new ContextManager()

  // Plan mode controller — shared between tools and IPC handler
  const planModeController = new PlanModeController()

  // Sender wrapper for plan-mode tools: broadcasts plan-mode events to mobile alongside renderer
  const getPlanModeSender = (): Electron.WebContents | null => {
    const wc = getWebContents()
    if (!wc) return null
    return {
      isDestroyed: () => wc.isDestroyed(),
      send: (channel: string, ...args: unknown[]) => {
        wc.send(channel, ...args)
        if (channel === IPC_CHANNELS['agent:plan-mode-entered']) {
          relayClient.broadcast('stream:agent:plan_mode_entered', args[0] ?? {})
        } else if (channel === IPC_CHANNELS['agent:plan-mode-exited']) {
          relayClient.broadcast('stream:agent:plan_mode_exited', args[0] ?? {})
        }
      }
    } as unknown as Electron.WebContents
  }

  toolRegistry.register(new EnterPlanModeTool(permissionManager, getPlanModeSender))
  toolRegistry.register(new ExitPlanModeTool(permissionManager, getPlanModeSender, planModeController))

  // AskUserQuestion tool — interactive question card in chat (Phase 4.2)
  const askUserTool = new AskUserQuestionTool(getWebContents)
  toolRegistry.register(askUserTool)

  // File history manager — snapshots files before each AI write for session-scoped revert
  const historyManager = new FileHistoryManager()

  // Instantiate Hooks system and register built-in hooks
  const hookRegistry = new HookRegistry()
  registerBuiltInHooks(hookRegistry)

  const agentLoopFactory = () => createDesktopAgentLoop({
    gateway,
    toolRegistry,
    permissionManager,
    contextManager,
    hookRegistry,
    historyManager,
  })
  // Per-session AgentLoop 运行时管理器。
  const runtimes = new SessionRuntimeManager(agentLoopFactory)
  // 启动定期清理：每 5 分钟检查，超过 30 分钟无活动的 runtime 被回收
  runtimes.startIdleCleanup(5 * 60 * 1000, 30 * 60 * 1000)
  // 默认 / 退退使用的 AgentLoop 实例：作为"全局 workspace"镜像（agentLoop.activeWorkspace）以及部分老接口读取。
  // 实际会话 run() 调用走 runtimes；该实例不被 .run()。
  const agentLoop = agentLoopFactory()
  logStartup('AgentLoop + MCP created')

  // 实例化 MCPManager（IPC 注册需要引用），但推迟 loadAndConnect 到 did-finish-load
  // 避免外部进程启动阻塞窗口创建
  const mcpManager = new MCPManager(toolRegistry)

  // 注册 MCP 资源工具（MCPManager 创建后才能注入，避免循环依赖）
  const { MCPListResourcesTool, MCPReadResourceTool } = await import('./tools/mcp-resource-tool')
  toolRegistry.register(new MCPListResourcesTool(mcpManager))
  toolRegistry.register(new MCPReadResourceTool(mcpManager))

  // Wire plugin registry with hook and MCP systems
  const { pluginRegistry } = await import('./plugins')
  pluginRegistry.setSettingsManager(settingsManager)
  pluginRegistry.setHookRegistry(hookRegistry)
  pluginRegistry.setMcpManager(mcpManager)

  // Register AgentTool (sub-agent) — must be after registry + agentLoop deps exist
  // Pass a getLatestConfig getter so sub-agents always use the current model/provider
  toolRegistry.register(
    new AgentTool(gateway, toolRegistry, permissionManager, contextManager, undefined, {
      provider: 'anthropic' as 'openai' | 'anthropic',
      model: '',
      workingDirectory,
      projectRoots: [workingDirectory],
    }, 0, () => {
      const cfg = settingsManager.getCurrentConfig()
      const wd = workspaceManager.getWorkspaceRoot() ?? workingDirectory
      return {
        provider: cfg.provider as 'openai' | 'anthropic',
        model: cfg.model,
        systemPrompt: cfg.systemPrompt,
        workingDirectory: wd,
        projectRoots: [wd],
      }
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

  // Forward relay status to renderer
  relayClient.on('status', (data) => {
    for (const bw of BrowserWindow.getAllWindows()) {
      bw.webContents.send(IPC_CHANNELS['relay:status'], data)
    }
  })

  // Clear saved relay token when server rejects it
  relayClient.on('token-rejected', () => {
    settingsManager.setRelayToken('')
  })

  // Session store reference — assigned after creation below, but captured by closure
  let sessionStore: SessionStore

  // ── Mobile Relay Handler ──────────────────────────────────────
  // All mobile relay logic (session sync, workspace, file browsing, agent commands)
  // extracted to mobile/mobile-relay-handler.ts
  const {
    getActiveSessionStore,
    getCachedSessionStore,
    sendWorkspaceInfoToMobile,
    broadcastToMobile,
    sessionTaskStates,
    getMobileSessionId,
    setMobileSessionId,
  } = registerMobileRelayHandler({
    relayClient,
    runtimes,
    sessionTaskStates: new SessionTaskStateManager(),
    permissionManager,
    settingsManager,
    workspaceManager,
    workspaceStore,
    toolRegistry,
    contextManager,
    planModeController,
    setSessionStore: (store: SessionStore) => { sessionStore = store },
    gateway,
    stepManager,
    notificationService,
    askUserTool,
    handleWorkspaceOpened,
    getWorkingDirectory: () => workspaceManager.getWorkspaceRoot() ?? process.cwd(),
  })

  // Register agent-related IPC handlers (ask-user, plan-mode, file-history, session:rewind)
  registerAgentIpcHandlers({
    askUserTool,
    planModeController,
    permissionManager,
    relayClient,
    historyManager,
    runtimes,
    getActiveSessionStore,
    getMainWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
  })

  // Register browser & mobile IPC handlers (extracted to dedicated modules)
  registerBrowserIpcHandlers({ browserManager })
  registerMobileIpcHandlers({ relayClient, settingsManager })

  // Create SessionStoreManager for centralized, cached SessionStore access
  const storeManager = new SessionStoreManager()
  // Create session store for JSONL persistence (per PERSIST-01)
  sessionStore = storeManager.getForRoot(workspaceManager.getWorkspaceRoot() ?? process.cwd())

  // Initialize step manager's persistence directory
  stepManager.setWorkspaceRoot(workspaceManager.getWorkspaceRoot() ?? process.cwd())

  // ── Host Management (SSH) 初始化 ──
  const hostStore = new HostStore()
  sshCredentials = new SshCredentials()
  await sshCredentials.load()
  logStartup('SSH credentials loaded')
  sshManager = new SshManager(sshCredentials)
  const sshExecutor = new SshExecutor(sshManager)
  const sshMonitor = new SshMonitor(sshExecutor)
  const sshSftp = new SshSftp(sshManager)
  const sshDocker = new SshDocker(sshExecutor)
  let mainWindow: BrowserWindow | null = null

  registerHostHandlers({
    hostStore, sshManager, credentials: sshCredentials, executor: sshExecutor,
    monitor: sshMonitor, sftp: sshSftp, docker: sshDocker,
    getMainWindow: () => mainWindow,
    onDataChanged: (event, data) => broadcastToMobile(event, data)
  })

  // Wire IPC handlers with all components including indexing engine.
  // Pass a callback so IPC handlers can notify when workspace opens.
  registerIpcHandlers(
    gateway, agentLoop, runtimes, permissionManager, workspaceManager, getActiveSessionStore,
    storeManager,
    contextManager, terminalManager, stepManager, indexingEngine, settingsManager,
    mcpManager, workspaceStore,
    (rootPath) => {
      handleWorkspaceOpened(rootPath, toolRegistry)
      // Persist last workspace path
      settingsManager.setLastWorkspacePath(rootPath)
      // Rebuild SessionStore for new workspace
      sessionStore = storeManager.getForRoot(rootPath)
      // Update step manager's persistence directory
      stepManager.setWorkspaceRoot(rootPath)
      // Reset mobile session and notify connected mobile
      setMobileSessionId(null)
      sendWorkspaceInfoToMobile()
    },
    // onDataChanged: broadcast desktop CRUD changes to mobile
    (event, data) => broadcastToMobile(event, data),
    // onStreamEvent: broadcast desktop agent stream events to mobile
    (event, data) => broadcastToMobile(event, data)
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

  // Hide native menu bar (using custom titlebar instead)
  Menu.setApplicationMenu(null)

  // IPC: update native titlebar overlay colors when theme changes
  ipcMain.handle(IPC_CHANNELS['theme:set-titlebar-overlay'], (_event, payload: { color: string; symbolColor: string }) => {
    const wins = BrowserWindow.getAllWindows()
    for (const win of wins) {
      try {
        win.setTitleBarOverlay({ color: payload.color, symbolColor: payload.symbolColor, height: 38 })
      } catch {
        // setTitleBarOverlay may not be available on all platforms
      }
    }
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  mainWindow = createWindow()
  logStartup('BrowserWindow created')

  // Deferred side-effects after renderer loads
  mainWindow.webContents.once('did-finish-load', () => {
    logStartup('renderer did-finish-load')
    // Restore workspace if saved
    setTimeout(() => {
      if (lastWsPath && fs.existsSync(lastWsPath)) {
        handleWorkspaceOpened(lastWsPath, toolRegistry)
        sessionStore = storeManager.getForRoot(lastWsPath)
        sendWorkspaceInfoToMobile()
      }
    }, 1200)
    // Restore last active session into renderer
    const lastSessionId = settingsManager.getLastSessionId()
    if (lastSessionId) {
      setTimeout(() => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS['session:restore'], { sessionId: lastSessionId })
        }
      }, 1200)
    }
    // Auto-connect to relay after renderer loads (non-blocking for first frame)
    if (savedRelayToken) {
      relayClient.connect(savedRelayToken)
      logStartup('relay connect dispatched (deferred to did-finish-load)')
    }
    // Always push current relay status after renderer loads
    // (relay may have connected before renderer mounted)
    setTimeout(() => {
      const status = relayClient.getStatus()
      console.log('[main] pushing relay status to renderer after load:', JSON.stringify(status))
      mainWindow.webContents.send(IPC_CHANNELS['relay:status'], status)
    }, 500)

    // MCP 服务器连接延迟到 renderer 加载后 — 避免进程启动阻塞首帧
    // 300ms 延迟确保首批 IPC 请求（会话恢复/列表）已处理完
    setTimeout(() => {
      mcpManager.loadAndConnect().catch((err) =>
        console.error('[MCP] Failed to load and connect servers:', err)
      )
      logStartup('MCP loadAndConnect dispatched (deferred)')
    }, 300)
  })

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
  // Persist alwaysAllow permission rules for next session + flush pending settings
  if (permissionManager) {
    settingsManager.saveAlwaysAllowRules(permissionManager.getAlwaysAllowRules())
  }
  // 确保防抖中的设置刷盘（同步版 — 退出时不能等异步）
  settingsManager.flushSync()
  // Dispose indexing engine
  if (indexingEngine) {
    indexingEngine.dispose()
    indexingEngine = null
  }
  terminalManager.dispose()
  workspaceManager.dispose()
  // 断开所有 SSH 连接
  sshManager?.disconnectAll()
  browserManager.close().catch(() => {})
  shutdownLangfuse().catch(() => {})
})
