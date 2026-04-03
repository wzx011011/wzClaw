import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS, IpcSchemas } from '../shared/ipc-channels'
import { DEFAULT_SYSTEM_PROMPT } from '../shared/constants'
import type { LLMGateway } from './llm/gateway'
import type { AgentLoop } from './agent/agent-loop'
import type { PermissionManager } from './permission/permission-manager'
import type { WorkspaceManager } from './workspace/workspace-manager'
import type { AgentConfig } from './agent/types'

// In-memory settings for Phase 1 (Phase 4 adds persistence)
let currentSettings = {
  provider: 'openai' as string,
  model: 'gpt-4o',
  hasApiKey: false,
  baseURL: undefined as string | undefined,
  systemPrompt: undefined as string | undefined,
}

// Store API keys in memory (Phase 4 uses safeStorage)
const apiKeys = new Map<string, string>()

export function registerIpcHandlers(
  gateway: LLMGateway,
  agentLoop: AgentLoop,
  permissionManager: PermissionManager,
  workspaceManager: WorkspaceManager
): void {
  // ============================================================
  // Agent: send message — triggers AgentLoop.run() and forwards
  // events to the renderer via webContents.send
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['agent:send_message'], async (event, request) => {
    const result = IpcSchemas['agent:send_message'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }

    const sender = event.sender

    // Build AgentConfig from current settings; use workspace root if available
    const workingDirectory = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    const config: AgentConfig = {
      model: currentSettings.model,
      systemPrompt: currentSettings.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      workingDirectory,
      conversationId: result.data.conversationId,
    }

    // Cleanup on window close
    const onWindowClosed = (): void => {
      agentLoop.cancel()
      permissionManager.clearSession(config.conversationId)
    }
    sender.once('destroyed', onWindowClosed)

    // Run agent loop and forward events to renderer
    try {
      for await (const agentEvent of agentLoop.run(result.data.content, config, sender)) {
        switch (agentEvent.type) {
          case 'agent:text':
            sender.send(IPC_CHANNELS['stream:text_delta'], { content: agentEvent.content })
            break
          case 'agent:tool_call':
            sender.send(IPC_CHANNELS['stream:tool_use_start'], {
              id: agentEvent.toolCallId,
              name: agentEvent.toolName,
            })
            break
          case 'agent:tool_result':
            sender.send(IPC_CHANNELS['stream:tool_use_end'], {
              id: agentEvent.toolCallId,
              parsedInput: {
                output: agentEvent.output,
                isError: agentEvent.isError,
                toolName: agentEvent.toolName,
              },
            })
            break
          case 'agent:permission_request':
            sender.send(IPC_CHANNELS['agent:permission_request'], {
              toolName: agentEvent.toolName,
              toolInput: agentEvent.input,
              reason: 'This tool can modify your files. Approve?',
            })
            break
          case 'agent:error':
            sender.send(IPC_CHANNELS['stream:error'], { error: agentEvent.error })
            break
          case 'agent:done':
            sender.send(IPC_CHANNELS['stream:done'], { usage: agentEvent.usage })
            break
        }
      }
    } catch (error) {
      sender.send(IPC_CHANNELS['stream:error'], {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      sender.removeListener('destroyed', onWindowClosed)
    }
  })

  // ============================================================
  // Agent: stop — cancels the running agent loop
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['agent:stop'], () => {
    agentLoop.cancel()
  })

  // Note: agent:permission_response is handled dynamically by
  // PermissionManager via ipcMain.handleOnce when a permission
  // request is in flight. No static handler needed here.

  // ============================================================
  // Settings: get
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['settings:get'], () => {
    return currentSettings
  })

  // ============================================================
  // Settings: update
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['settings:update'], (_event, request) => {
    if (request.provider) currentSettings.provider = request.provider
    if (request.model) currentSettings.model = request.model
    if (request.apiKey) {
      apiKeys.set(currentSettings.provider, request.apiKey)
      currentSettings.hasApiKey = true
    }
    if (request.baseURL !== undefined) currentSettings.baseURL = request.baseURL
    if (request.systemPrompt !== undefined) currentSettings.systemPrompt = request.systemPrompt
  })

  // ============================================================
  // Workspace: open folder — shows native dialog, sets workspace
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['workspace:open_folder'], async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null

    const rootPath = await workspaceManager.openFolderDialog(win)
    if (rootPath) {
      // Forward file change events to all windows
      workspaceManager.onFileChange((filePath, changeType) => {
        for (const bw of BrowserWindow.getAllWindows()) {
          bw.webContents.send(IPC_CHANNELS['file:changed'], { filePath, changeType })
        }
      })
      return { rootPath }
    }
    return null
  })

  // ============================================================
  // Workspace: get directory tree
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['workspace:get_tree'], async (_event, request) => {
    return workspaceManager.getDirectoryTree(request?.dirPath, request?.depth)
  })

  // ============================================================
  // Workspace: start watching
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['workspace:watch'], () => {
    workspaceManager.startWatching()
  })

  // ============================================================
  // Workspace: status
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['workspace:status'], () => {
    return {
      rootPath: workspaceManager.getWorkspaceRoot(),
      isWatching: workspaceManager.isWatching()
    }
  })

  // ============================================================
  // File: read
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:read'], async (_event, request) => {
    return workspaceManager.readFile(request.filePath)
  })

  // ============================================================
  // File: save
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:save'], async (_event, request) => {
    await workspaceManager.saveFile(request.filePath, request.content)
  })
}
