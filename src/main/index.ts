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
const { join } = path
import { networkInterfaces } from 'os'

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
import { HookRegistry } from './hooks/hook-registry'
import { registerBuiltInHooks } from './hooks/built-in-hooks'
import { CreateTaskTool } from './tools/create-task'
import { UpdateTaskTool } from './tools/update-task'
import { IndexingEngine } from './indexing/indexing-engine'
import { EmbeddingClient } from './indexing/embedding-client'
import { SettingsManager } from './settings-manager'
import { ToolRegistry } from './tools/tool-registry'
import { IPC_CHANNELS } from '../shared/ipc-channels'
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
import { MobileServer } from './mobile/mobile-server'
import { TunnelManager } from './mobile/tunnel-manager'
import { generateQRCode } from './mobile/qr-generator'
import { RelayClient } from './mobile/relay-client'
import { ensureAppDirs } from './paths'
import { cleanOldDebugFiles, cleanOldMediaFiles } from './utils/debug-logger'

const gateway = new LLMGateway()
const workspaceManager = new WorkspaceManager()
const terminalManager = new TerminalManager()
const taskManager = new TaskManager()
// These services are initialized lazily inside app.whenReady() to speed up startup
let browserManager!: BrowserManager
let mobileServer!: MobileServer
let tunnelManager!: TunnelManager
let relayClient!: RelayClient

// Module-level IndexingEngine reference (created when workspace opens)
let indexingEngine: IndexingEngine | null = null

// Module-level PermissionManager (needed in before-quit handler)
let permissionManager: PermissionManager | null = null

// Persistent settings for embedding API configuration
const settingsManager = new SettingsManager()

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

  // DEBUG: auto-open DevTools to catch renderer errors (dev mode only)
  if (is.dev) mainWindow.webContents.openDevTools({ mode: 'detach' })

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
    ;(searchTool as any).setIndexingEngine(indexingEngine)
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
  electronApp.setAppUserModelId('com.wzxclaw')

  // 创建所有运行时所需目录（cache/debug/paste-cache/shell-snapshots/backups）
  await ensureAppDirs()
  logStartup('ensureAppDirs done')
  // 清理 7 天以上的旧文件（一次性，非热路径）
  cleanOldDebugFiles().catch(() => {})
  cleanOldMediaFiles().catch(() => {})

  // Load persisted settings for embedding API config
  settingsManager.load()
  logStartup('settingsManager loaded')

  // Initialize deferred services (after app is ready, before window creation)
  browserManager = new BrowserManager()
  mobileServer = new MobileServer()
  tunnelManager = new TunnelManager()
  relayClient = new RelayClient()
  logStartup('services instantiated')

  // Restore last workspace if saved
  const lastWsPath = settingsManager.getLastWorkspacePath()
  if (lastWsPath && require('fs').existsSync(lastWsPath)) {
    workspaceManager.setWorkspaceRoot(lastWsPath)
  }

  // Auto-connect to relay if token is saved
  const savedRelayToken = settingsManager.getRelayToken()
  if (savedRelayToken) {
    relayClient.connect(savedRelayToken)
  }
  logStartup('relay connect dispatched')

  // Create tool registry with workspace root when available
  const workingDirectory = workspaceManager.getWorkspaceRoot() ?? process.cwd()
  const getWebContents = () => BrowserWindow.getAllWindows()[0]?.webContents ?? null
  const toolRegistry = createDefaultTools(workingDirectory, terminalManager, getWebContents, taskManager, indexingEngine)
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
          mobileServer.broadcast('stream:agent:plan_mode_entered', args[0] ?? {})
          relayClient.broadcast('stream:agent:plan_mode_entered', args[0] ?? {})
        } else if (channel === IPC_CHANNELS['agent:plan-mode-exited']) {
          mobileServer.broadcast('stream:agent:plan_mode_exited', args[0] ?? {})
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

  // IPC handler: renderer sends back the user's answer
  ipcMain.handle(IPC_CHANNELS['ask-user:answer'], (_event, answer: AskUserAnswer) => {
    askUserTool.resolveQuestion(answer)
  })

  // IPC handler: renderer sends plan approve/reject decision
  ipcMain.handle(IPC_CHANNELS['agent:plan-decision'], (_event, request: { approved: boolean }) => {
    planModeController.resolveDecision(request.approved)
  })

  // IPC handlers: file history and revert (Phase 3.3)
  ipcMain.handle(IPC_CHANNELS['file:get-history'], (_event, request: { filePath: string }) => {
    return historyManager.getEntriesForFile(request.filePath).map((e) => ({
      toolCallId: e.toolCallId,
      timestamp: e.timestamp,
      filePath: e.filePath
    }))
  })

  ipcMain.handle(IPC_CHANNELS['file:revert'], async (_event, request: { toolCallId: string }) => {
    const entry = historyManager.getByToolCallId(request.toolCallId)
    if (!entry) return { success: false, error: 'No snapshot found for this tool call' }
    try {
      const fsp = await import('fs/promises')
      await fsp.writeFile(entry.filePath, entry.content, 'utf-8')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Instantiate Hooks system and register built-in hooks
  const hookRegistry = new HookRegistry()
  registerBuiltInHooks(hookRegistry)

  // File history manager — snapshots files before each AI write for session-scoped revert
  const historyManager = new FileHistoryManager()

  const agentLoop = new AgentLoop(gateway, toolRegistry, permissionManager, contextManager, hookRegistry, historyManager)
  logStartup('AgentLoop + MCP created')

  // Instantiate and connect MCP servers (tools auto-register into toolRegistry)
  const mcpManager = new MCPManager(toolRegistry)
  mcpManager.loadAndConnect().catch((err) =>
    console.error('[MCP] Failed to load and connect servers:', err)
  )

  // Register AgentTool (sub-agent) — must be after registry + agentLoop deps exist
  // Pass a getLatestConfig getter so sub-agents always use the current model/provider
  toolRegistry.register(
    new AgentTool(gateway, toolRegistry, permissionManager, contextManager, undefined, {
      provider: 'anthropic' as any,
      model: '',
      workingDirectory
    }, 0, () => {
      const cfg = settingsManager.getCurrentConfig()
      return {
        provider: cfg.provider as 'openai' | 'anthropic',
        model: cfg.model,
        systemPrompt: cfg.systemPrompt,
        workingDirectory: workspaceManager.getWorkspaceRoot() ?? workingDirectory
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

  // Forward mobile server status to renderer
  mobileServer.on('status', (data) => {
    for (const bw of BrowserWindow.getAllWindows()) {
      bw.webContents.send(IPC_CHANNELS['mobile:status'], data)
    }
  })

  // Forward relay status to renderer
  relayClient.on('status', (data) => {
    for (const bw of BrowserWindow.getAllWindows()) {
      bw.webContents.send(IPC_CHANNELS['relay:status'], data)
    }
  })

  // Session store reference — assigned after creation below, but captured by closure
  let sessionStore: SessionStore
  // Track mobile session ID for persisting mobile-initiated conversations
  let mobileSessionId: string | null = null

  // Helper: broadcast to both mobile transports
  const broadcastToMobile = (event: string, data: unknown) => {
    mobileServer.broadcast(event, data)
    relayClient.broadcast(event, data)
  }

  // Helper: send workspace info to mobile
  const sendWorkspaceInfoToMobile = async () => {
    const workspaceRoot = workspaceManager.getWorkspaceRoot()
    if (!workspaceRoot || !sessionStore) return
    try {
      const sessions = await sessionStore.listSessions()
      broadcastToMobile('session:workspace:info', {
        workspaceName: path.basename(workspaceRoot),
        workspacePath: workspaceRoot,
        activeSessionId: mobileSessionId,
        sessionCount: sessions.length
      })
    } catch (err) {
      console.error('[sendWorkspaceInfoToMobile]', err)
    }
  }

  // Handle mobile client commands → agent (from local mobileServer or relay)
  const handleClientMessage = async (msg: { clientId: string; event: string; data: any }) => {
    console.log('[handleClientMessage]', msg.clientId, msg.event, JSON.stringify(msg.data)?.substring(0, 200))
    try {

    // -- Session sync: list sessions --
    if (msg.event === 'session:list:request') {
      const requestId = msg.data?.requestId ?? ''
      const workspaceRoot = workspaceManager.getWorkspaceRoot()
      if (!workspaceRoot || !sessionStore) {
        broadcastToMobile('session:error', { requestId, error: 'No workspace open', code: 'NO_WORKSPACE' })
        return
      }
      try {
        const sessions = await sessionStore.listSessions()
        broadcastToMobile('session:list:response', {
          requestId,
          workspaceName: path.basename(workspaceRoot),
          workspacePath: workspaceRoot,
          sessions
        })
      } catch (err: any) {
        broadcastToMobile('session:error', { requestId, error: err.message, code: 'INTERNAL_ERROR' })
      }
      return
    }

    // -- Session sync: load session messages (with pagination) --
    if (msg.event === 'session:load:request') {
      const { requestId = '', sessionId, offset = 0, limit = 50 } = msg.data ?? {}
      if (!sessionStore) {
        broadcastToMobile('session:error', { requestId, error: 'No workspace open', code: 'NO_WORKSPACE' })
        return
      }
      try {
        const allMessages = await sessionStore.loadSession(sessionId)
        const total = allMessages.length
        const sliced = allMessages.slice(offset, offset + limit)
        broadcastToMobile('session:load:response', {
          requestId,
          sessionId,
          messages: sliced,
          total,
          offset,
          hasMore: (offset + limit) < total
        })
      } catch (err: any) {
        broadcastToMobile('session:error', { requestId, error: err.message, code: 'SESSION_NOT_FOUND' })
      }
      return
    }

    // -- Session sync: create session --
    if (msg.event === 'session:create:request') {
      const requestId = msg.data?.requestId ?? ''
      if (!sessionStore) {
        broadcastToMobile('session:error', { requestId, error: 'No workspace open', code: 'NO_WORKSPACE' })
        return
      }
      try {
        const title = msg.data?.title || 'New Session'
        const sessionId = crypto.randomUUID()
        // Create the session file with a meta line
        const metaLine = JSON.stringify({ type: 'meta', title }) + '\n'
        const fsp = await import('fs/promises')
        const sessionPath = path.join(
          (sessionStore as any).sessionsDir,
          `${sessionId}.jsonl`
        )
        await fsp.writeFile(sessionPath, metaLine, 'utf-8')
        broadcastToMobile('session:create:response', {
          requestId,
          session: { id: sessionId, title, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 }
        })
      } catch (err: any) {
        broadcastToMobile('session:error', { requestId, error: err.message, code: 'INTERNAL_ERROR' })
      }
      return
    }

    // -- Session sync: delete session --
    if (msg.event === 'session:delete:request') {
      const requestId = msg.data?.requestId ?? ''
      const sessionId = msg.data?.sessionId
      if (!sessionStore || !sessionId) {
        broadcastToMobile('session:error', { requestId, error: 'No workspace or session ID', code: 'NO_WORKSPACE' })
        return
      }
      try {
        const success = await sessionStore.deleteSession(sessionId)
        broadcastToMobile('session:delete:response', { requestId, success })
      } catch (err: any) {
        broadcastToMobile('session:error', { requestId, error: err.message, code: 'INTERNAL_ERROR' })
      }
      return
    }

    // -- Session sync: rename session --
    if (msg.event === 'session:rename:request') {
      const requestId = msg.data?.requestId ?? ''
      const sessionId = msg.data?.sessionId
      const title = msg.data?.title
      if (!sessionStore || !sessionId || !title) {
        broadcastToMobile('session:error', { requestId, error: 'Missing parameters', code: 'BAD_REQUEST' })
        return
      }
      try {
        const success = await sessionStore.renameSession(sessionId, title)
        broadcastToMobile('session:rename:response', { requestId, success })
      } catch (err: any) {
        broadcastToMobile('session:error', { requestId, error: err.message, code: 'INTERNAL_ERROR' })
      }
      return
    }

    // -- Workspace: list recent workspaces --
    if (msg.event === 'workspace:list:request') {
      const requestId = msg.data?.requestId ?? ''
      try {
        const workspaces = settingsManager.getRecentWorkspaces()
        const currentRoot = workspaceManager.getWorkspaceRoot()
        broadcastToMobile('workspace:list:response', {
          requestId,
          workspaces: workspaces.map(w => ({
            path: w,
            name: path.basename(w),
            isCurrent: w === currentRoot,
          })),
        })
      } catch (err: any) {
        broadcastToMobile('session:error', { requestId, error: err.message, code: 'INTERNAL_ERROR' })
      }
      return
    }

    // -- Workspace: switch to a different workspace --
    if (msg.event === 'workspace:switch:request') {
      const requestId = msg.data?.requestId ?? ''
      const workspacePath = msg.data?.workspacePath
      if (!workspacePath) {
        broadcastToMobile('session:error', { requestId, error: 'Missing workspacePath', code: 'BAD_REQUEST' })
        return
      }
      try {
        const fsSync = await import('fs')
        if (!fsSync.existsSync(workspacePath)) {
          broadcastToMobile('workspace:switch:response', { requestId, success: false, error: 'Path does not exist' })
          return
        }
        // Trigger workspace open — reuses the existing onWorkspaceOpened flow
        workspaceManager.setWorkspaceRoot(workspacePath)
        handleWorkspaceOpened(workspacePath, toolRegistry)
        agentLoop.reset()
        sessionStore = new SessionStore(workspacePath)
        settingsManager.setLastWorkspacePath(workspacePath)
        sendWorkspaceInfoToMobile()
        broadcastToMobile('workspace:switch:response', {
          requestId,
          success: true,
          workspaceName: path.basename(workspacePath),
        })
      } catch (err: any) {
        broadcastToMobile('workspace:switch:response', { requestId, success: false, error: err.message })
      }
      return
    }

    // -- File browsing: get directory tree --
    if (msg.event === 'file:tree:request') {
      const requestId = msg.data?.requestId ?? ''
      const workspaceRoot = workspaceManager.getWorkspaceRoot()
      if (!workspaceRoot) {
        broadcastToMobile('session:error', { requestId, error: 'No workspace open', code: 'NO_WORKSPACE' })
        return
      }
      try {
        const dirPath = msg.data?.dirPath || workspaceRoot
        const depth = msg.data?.depth || 2
        const nodes = await workspaceManager.getDirectoryTree(dirPath, depth)
        broadcastToMobile('file:tree:response', { requestId, nodes })
      } catch (err: any) {
        broadcastToMobile('session:error', { requestId, error: err.message, code: 'INTERNAL_ERROR' })
      }
      return
    }

    // -- File browsing: read file content --
    if (msg.event === 'file:read:request') {
      const requestId = msg.data?.requestId ?? ''
      const filePath = msg.data?.filePath
      const workspaceRoot = workspaceManager.getWorkspaceRoot()
      if (!workspaceRoot || !filePath) {
        broadcastToMobile('session:error', { requestId, error: 'No workspace or file path', code: 'BAD_REQUEST' })
        return
      }
      try {
        const absolutePath = require('path').isAbsolute(filePath) ? filePath : require('path').resolve(workspaceRoot, filePath)

        // Security: verify path is within workspace
        const normalizedPath = require('path').resolve(absolutePath).toLowerCase()
        const normalizedRoot = require('path').resolve(workspaceRoot).toLowerCase()
        if (!normalizedPath.startsWith(normalizedRoot)) {
          broadcastToMobile('session:error', { requestId, error: 'Access denied: path outside workspace', code: 'ACCESS_DENIED' })
          return
        }

        const fs = await import('fs/promises')
        const stat = await fs.stat(absolutePath)

        // Limit to 500KB for mobile
        if (stat.size > 512000) {
          broadcastToMobile('file:read:response', {
            requestId,
            error: 'File too large',
            size: stat.size,
            filePath
          })
          return
        }

        const content = await fs.readFile(absolutePath, 'utf-8')

        // Detect language from extension
        const ext = require('path').extname(absolutePath).slice(1).toLowerCase()
        const langMap: Record<string, string> = {
          ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
          py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
          dart: 'dart', swift: 'swift', c: 'c', cpp: 'cpp', h: 'c',
          css: 'css', scss: 'scss', html: 'html', xml: 'xml',
          json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
          md: 'markdown', sh: 'bash', bash: 'bash', sql: 'sql',
        }
        const language = langMap[ext] ?? ext

        broadcastToMobile('file:read:response', {
          requestId,
          content,
          language,
          size: stat.size,
          filePath: require('path').relative(workspaceRoot, absolutePath).replace(/\\\\/g, '/'),
        })
      } catch (err: any) {
        broadcastToMobile('session:error', { requestId, error: err.message, code: 'INTERNAL_ERROR' })
      }
      return
    }

    // -- Plan Mode: mobile approval/rejection --
    if (msg.event === 'plan:decision') {
      planModeController.resolveDecision(msg.data?.approved === true)
      return
    }

    // -- AskUserQuestion: mobile sends back the user's answer --
    if (msg.event === 'ask-user:answer') {
      const answer = msg.data as { questionId: string; selectedLabels: string[]; customText?: string }
      askUserTool.resolveQuestion(answer)
      return
    }

    // -- Agent command: send --
    if (msg.event === 'command:send' && msg.data?.content) {
      // Slash command preprocessing for mobile
      const trimmed = (msg.data.content as string).trim()
      if (trimmed.startsWith('/')) {
        const spaceIdx = trimmed.indexOf(' ')
        const cmdName = spaceIdx > 0 ? trimmed.substring(1, spaceIdx) : trimmed.substring(1)
        const _cmdArgs = spaceIdx > 0 ? trimmed.substring(spaceIdx + 1).trim() : ''

        switch (cmdName) {
          case 'compact': {
            // Trigger manual context compaction
            const messages = agentLoop.getMessages()
            const compactConfig = settingsManager.getCurrentConfig()
            if (messages.length > 0) {
              contextManager.compact(
                messages,
                gateway,
                compactConfig.model,
                compactConfig.provider,
                compactConfig.systemPrompt
              ).then((result) => {
                if (result.summary) {
                  const summaryMsg = {
                    role: 'user' as const,
                    content: `[Context Summary]\n${result.summary}`,
                    timestamp: Date.now()
                  }
                  const recentMessages = messages.slice(-result.keptRecentCount)
                  agentLoop.replaceMessages([summaryMsg, ...recentMessages])
                }
                broadcastToMobile('stream:agent:done', { usage: null, compacted: true, beforeTokens: result.beforeTokens, afterTokens: result.afterTokens })
              }).catch((err: any) => {
                broadcastToMobile('stream:error', { error: err.message })
              })
            } else {
              broadcastToMobile('stream:agent:done', { usage: null })
            }
            return
          }
          case 'clear': {
            // Create new session and reset agent loop
            mobileSessionId = null
            agentLoop.reset()
            broadcastToMobile('session:create:response', { success: true })
            return
          }
          case 'init': {
            // Replace content with the /init prompt, continue to agentLoop.run()
            msg.data.content = `Please analyze this codebase and create a WZXCLAW.md file in the project root.\n\nFirst, explore the project to understand:\n- Package manager and key scripts\n- README and existing documentation\n- Directory structure and main source directories\n- Test setup and how to run tests\n- Any existing instruction files\n\nThen create WZXCLAW.md with ONLY:\n1. Build & Dev Commands (non-obvious only)\n2. Architecture Overview (3-5 sentences)\n3. Key Conventions (differs from defaults)\n4. Development Notes (gotchas, setup)\n\nKeep it under 100 lines. If WZXCLAW.md exists, suggest improvements.`
            break
          }
          // Other commands pass through as regular text
        }
      }

      // Use session ID from mobile, or generate one for this mobile conversation
      const sessionId = msg.data.sessionId || mobileSessionId || crypto.randomUUID()
      mobileSessionId = sessionId

      const config = settingsManager.getCurrentConfig()
      // Ensure LLM adapter is registered (matches ipc-handlers.ts logic)
      if (config.apiKey) {
        gateway.addProvider({
          provider: config.provider as 'openai' | 'anthropic',
          apiKey: config.apiKey,
          baseURL: config.baseURL,
        })
      }
      const agentConfig: AgentConfig = {
        model: config.model,
        provider: config.provider as 'openai' | 'anthropic',
        systemPrompt: config.systemPrompt,
        workingDirectory,
        conversationId: sessionId,
        thinkingDepth: config.thinkingDepth as 'none' | 'low' | 'medium' | 'high' | undefined,
      }

      // Broadcast the assigned session ID back to mobile so it can track it
      broadcastToMobile('session:active', { sessionId })

      // If resuming an existing mobile session, restore chat history into agentLoop
      if (msg.data.sessionId && sessionStore && agentLoop.getMessages().length === 0) {
        try {
          const rawMessages = await sessionStore.loadSession(msg.data.sessionId)
          if (rawMessages.length > 0) {
            await agentLoop.restoreContext(rawMessages, agentConfig)
          }
        } catch { /* session not found — start fresh */ }
      }

      // Send the mobile user's message to renderer so it appears in the chat
      const wc0 = BrowserWindow.getAllWindows()[0]?.webContents
      if (wc0) {
        wc0.send(IPC_CHANNELS['stream:mobile_user_message'], {
          content: msg.data.content,
          source: 'mobile'
        })
      }

      try {
        // Mobile sender: forwards stream:retrying to mobile alongside the renderer
        const wcForMobile = BrowserWindow.getAllWindows()[0]?.webContents
        const mobileSender = {
          isDestroyed: () => wcForMobile?.isDestroyed() ?? true,
          send: (channel: string, ...args: unknown[]) => {
            if (wcForMobile && !wcForMobile.isDestroyed()) wcForMobile.send(channel, ...args)
            if (channel === IPC_CHANNELS['stream:retrying']) {
              mobileServer.broadcast('stream:retrying', args[0] ?? {})
              relayClient.broadcast('stream:retrying', args[0] ?? {})
            }
            if (channel === IPC_CHANNELS['ask-user:question']) {
              mobileServer.broadcast('stream:agent:ask_user_question', args[0])
              relayClient.broadcast('stream:agent:ask_user_question', args[0])
            }
          }
        } as unknown as Electron.WebContents
        for await (const agentEvent of agentLoop.run(msg.data.content, agentConfig, mobileSender)) {
          // Forward stream events to renderer
          const wc = BrowserWindow.getAllWindows()[0]?.webContents
          if (wc) {
            switch (agentEvent.type) {
              case 'agent:text':
                wc.send(IPC_CHANNELS['stream:text_delta'], { content: agentEvent.content })
                break
              case 'agent:thinking':
                wc.send(IPC_CHANNELS['stream:thinking_delta'], { content: agentEvent.content })
                break
              case 'agent:tool_call':
                wc.send(IPC_CHANNELS['stream:tool_use_start'], { id: agentEvent.toolCallId, name: agentEvent.toolName })
                break
              case 'agent:tool_result':
                wc.send(IPC_CHANNELS['stream:tool_use_end'], { id: agentEvent.toolCallId, output: agentEvent.output, isError: agentEvent.isError, toolName: agentEvent.toolName })
                // Forward file changes for write tools (same as ipc-handlers path)
                if (!agentEvent.isError && (agentEvent.toolName === 'FileWrite' || agentEvent.toolName === 'FileEdit')) {
                  const tc = (agentEvent as any).input
                  const filePath = tc?.path as string | undefined
                  if (filePath) {
                    const absolutePath = require('path').isAbsolute(filePath) ? filePath : require('path').resolve(agentConfig.workingDirectory, filePath)
                    wc.send(IPC_CHANNELS['file:changed'], { filePath: absolutePath, changeType: 'modified' })
                  }
                }
                break
              case 'agent:error':
                wc.send(IPC_CHANNELS['stream:error'], { error: agentEvent.error })
                break
              case 'agent:turn_end':
                wc.send(IPC_CHANNELS['stream:turn_end'], {})
                break
              case 'agent:done':
                wc.send(IPC_CHANNELS['stream:done'], { usage: agentEvent.usage })
                break
              case 'agent:compacted':
                wc.send(IPC_CHANNELS['session:compacted'], {
                  beforeTokens: agentEvent.beforeTokens,
                  afterTokens: agentEvent.afterTokens,
                  auto: agentEvent.auto
                })
                break
            }
          }
          mobileServer.broadcast(`stream:${agentEvent.type}`, agentEvent)
          relayClient.broadcast(`stream:${agentEvent.type}`, agentEvent)
          // Forward TodoWrite structured todo list to mobile
          if (agentEvent.type === 'agent:tool_result' && agentEvent.toolName === 'TodoWrite' && !agentEvent.isError) {
            const todoTool = toolRegistry.get('TodoWrite') as { getCurrentTodos?: () => unknown[] } | undefined
            if (todoTool?.getCurrentTodos) {
              broadcastToMobile('todo:updated', { todos: todoTool.getCurrentTodos() })
            }
          }
        }
      } catch (err: any) {
        mobileServer.broadcast('stream:error', { error: err.message })
        relayClient.broadcast('stream:error', { error: err.message })
      }
      return
    }

    if (msg.event === 'command:stop') {
      agentLoop.cancel()
    }
    } catch (topErr: any) {
      console.error('[handleClientMessage] UNCAUGHT ERROR:', topErr)
    }
  }

  mobileServer.on('client-message', handleClientMessage)
  relayClient.on('client-message', handleClientMessage)

  // Send workspace info when mobile connects via relay
  relayClient.on('mobile-connected', () => {
    sendWorkspaceInfoToMobile()
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

  // Relay IPC handlers
  ipcMain.handle(IPC_CHANNELS['relay:connect'], async (_e, request: { token: string }) => {
    if (request.token) {
      settingsManager.setRelayToken(request.token)
    }
    const token = request.token || settingsManager.getRelayToken()
    if (token) {
      relayClient.connect(token)
    }
    return relayClient.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS['relay:disconnect'], async () => {
    relayClient.disconnect()
  })

  ipcMain.handle(IPC_CHANNELS['relay:get_status'], async () => {
    return relayClient.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS['relay:qrcode'], async (_e, request?: { token: string }) => {
    let token = request?.token || settingsManager.getRelayToken()
    // Auto-generate a random token if none configured — user just needs to scan
    if (!token) {
      token = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      settingsManager.setRelayToken(token)
    }
    // Ensure desktop is connected to relay with this token
    if (!relayClient.connected) {
      relayClient.connect(token)
    }
    const { generateQRCode } = await import('./mobile/qr-generator')
    const relayUrl = `https://relay.5945.top/?token=${encodeURIComponent(token)}`
    const qrCode = await generateQRCode(relayUrl)
    return { qrCode, token }
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
    relayClient.dispose()
    await mobileServer.stop()
  })

  // Create session store for JSONL persistence (per PERSIST-01)
  sessionStore = new SessionStore(workspaceManager.getWorkspaceRoot() ?? process.cwd())

  // Wire IPC handlers with all components including indexing engine.
  // Pass a callback so IPC handlers can notify when workspace opens.
  registerIpcHandlers(
    gateway, agentLoop, permissionManager, workspaceManager, () => sessionStore,
    contextManager, terminalManager, taskManager, indexingEngine, settingsManager,
    mcpManager,
    (rootPath) => {
      handleWorkspaceOpened(rootPath, toolRegistry)
      // Persist last workspace path
      settingsManager.setLastWorkspacePath(rootPath)
      // Rebuild SessionStore for new workspace
      sessionStore = new SessionStore(rootPath)
      // Reset mobile session and notify connected mobile
      mobileSessionId = null
      sendWorkspaceInfoToMobile()
    }
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
  ipcMain.handle('theme:set-titlebar-overlay', (_event, payload: { color: string; symbolColor: string }) => {
    const wins = BrowserWindow.getAllWindows()
    for (const win of wins) {
      try {
        win.setTitleBarOverlay({ color: payload.color, symbolColor: payload.symbolColor, height: 38 })
      } catch (_) {
        // setTitleBarOverlay may not be available on all platforms
      }
    }
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  const mainWindow = createWindow()
  logStartup('BrowserWindow created')

  // Deferred side-effects after renderer loads
  mainWindow.webContents.once('did-finish-load', () => {
    logStartup('renderer did-finish-load')
    // Restore workspace if saved
    if (lastWsPath && require('fs').existsSync(lastWsPath)) {
      handleWorkspaceOpened(lastWsPath, toolRegistry)
      sessionStore = new SessionStore(lastWsPath)
      sendWorkspaceInfoToMobile()
    }
    // Restore last active session into renderer
    const lastSessionId = settingsManager.getLastSessionId()
    if (lastSessionId) {
      mainWindow.webContents.send('session:restore', { sessionId: lastSessionId })
    }
    // Always push current relay status after renderer loads
    // (relay may have connected before renderer mounted)
    setTimeout(() => {
      const status = relayClient.getStatus()
      console.log('[main] pushing relay status to renderer after load:', JSON.stringify(status))
      mainWindow.webContents.send(IPC_CHANNELS['relay:status'], status)
    }, 500)
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
  // Persist alwaysAllow permission rules for next session
  if (permissionManager) {
    settingsManager.saveAlwaysAllowRules(permissionManager.getAlwaysAllowRules())
  }
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
