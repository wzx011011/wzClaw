// ============================================================
// Bootstrap Stage 2 — create-core-managers
// 实例化所有核心服务：ToolRegistry、PermissionManager、HandBridge、
// MCP、Hooks、PlanMode、AskUser、SSH 等
// ============================================================

import { BrowserWindow } from 'electron'
import { PermissionManager, HookRegistry, registerBuiltInHooks } from '@wzxclaw/brain'
import { HandBridge } from '../hand-bridge'
import { PlanModeController } from '../tools/plan-mode'
import { AskUserQuestionTool } from '../tools/ask-user'
import { FileHistoryManager } from '../file-history/file-history-manager'
import { MCPManager } from '../mcp/mcp-manager'
import { HostStore } from '../hosts/host-store'
import { SshCredentials } from '../hosts/ssh-credentials'
import { SshManager } from '../hosts/ssh-manager'
import { SshExecutor } from '../hosts/ssh-executor'
import { SshMonitor } from '../hosts/ssh-monitor'
import { SshSftp } from '../hosts/ssh-sftp'
import { SshDocker } from '../hosts/ssh-docker'
import { createDefaultTools, ToolRegistry } from '../tools/tool-registry'
import type { IndexingEngine } from '../indexing/indexing-engine'
import type { InitialServices } from './init-services'

export interface CoreManagers {
  toolRegistry: ToolRegistry
  permissionManager: PermissionManager
  handBridge: HandBridge
  planModeController: PlanModeController
  askUserTool: AskUserQuestionTool
  historyManager: FileHistoryManager
  hookRegistry: HookRegistry
  mcpManager: MCPManager
  /** 共享可变引用 — IPC handlers 与 onWorkspaceOpened 回调共用同一个对象 */
  indexingEngineRef: { current: IndexingEngine | null }
  // SSH 管理器
  hostStore: HostStore
  sshCredentials: SshCredentials
  sshManager: SshManager
  sshExecutor: SshExecutor
  sshMonitor: SshMonitor
  sshSftp: SshSftp
  sshDocker: SshDocker
}

export async function createCoreManagers(
  services: InitialServices,
  logStartup: (label: string) => void
): Promise<CoreManagers> {
  const { settingsManager, workspaceManager, terminalManager, backgroundTaskManager } = services

  const workingDirectory = workspaceManager.getWorkspaceRoot() ?? process.cwd()
  const getWebContents = () => BrowserWindow.getAllWindows()[0]?.webContents ?? null

  // IndexingEngine 共享引用 — 初始为 null，workspace 打开时更新
  const indexingEngineRef: { current: IndexingEngine | null } = { current: null }

  // ToolRegistry 先创建（HandBridge 依赖它）
  const toolRegistry = createDefaultTools(
    workingDirectory, terminalManager, getWebContents, undefined, null, backgroundTaskManager
  )

  const permissionManager = new PermissionManager()
  permissionManager.loadAlwaysAllowRules(settingsManager.getAlwaysAllowRules())

  const handBridge = new HandBridge({ toolRegistry, settingsManager, workingDirectory })
  logStartup('HandBridge instantiated')

  const planModeController = new PlanModeController()
  const askUserTool = new AskUserQuestionTool(getWebContents)
  const historyManager = new FileHistoryManager()

  const hookRegistry = new HookRegistry()
  registerBuiltInHooks(hookRegistry)

  const mcpManager = new MCPManager(toolRegistry)

  // SSH 初始化
  const hostStore = new HostStore()
  const sshCredentials = new SshCredentials()
  await sshCredentials.load()
  logStartup('SSH credentials loaded')
  const sshManager = new SshManager(sshCredentials)
  const sshExecutor = new SshExecutor(sshManager)
  const sshMonitor = new SshMonitor(sshExecutor)
  const sshSftp = new SshSftp(sshManager)
  const sshDocker = new SshDocker(sshExecutor)

  return {
    toolRegistry, permissionManager, handBridge, planModeController, askUserTool,
    historyManager, hookRegistry, mcpManager, indexingEngineRef,
    hostStore, sshCredentials, sshManager, sshExecutor, sshMonitor, sshSftp, sshDocker,
  }
}
