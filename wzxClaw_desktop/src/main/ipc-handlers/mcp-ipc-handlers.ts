// ============================================================
// MCP IPC Handlers — mcp:* + tools:list + system:doctor
// ============================================================

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { MCPManager } from '../mcp/mcp-manager'
import type { ToolRegistry } from '../tools/tool-registry'
import type { SettingsManager } from '../settings-manager'

export interface McpIpcDeps {
  mcpManager: MCPManager
  toolRegistry: ToolRegistry
  settingsManager: SettingsManager
}

export function registerMcpIpcHandlers(deps: McpIpcDeps): void {
  const { mcpManager, toolRegistry, settingsManager } = deps

  ipcMain.handle(IPC_CHANNELS['mcp:list_servers'], async () => {
    return mcpManager.listServers()
  })

  ipcMain.handle(IPC_CHANNELS['mcp:list_tools'], async () => {
    return mcpManager.listAllTools()
  })

  ipcMain.handle(IPC_CHANNELS['mcp:add_server'], async (_event, request) => {
    await mcpManager.addServer({
      name: request.name,
      transport: request.transport,
      command: request.command,
      args: request.args,
      url: request.url
    })
  })

  ipcMain.handle(IPC_CHANNELS['mcp:remove_server'], async (_event, request) => {
    await mcpManager.removeServer(request.name)
  })

  ipcMain.handle(IPC_CHANNELS['tools:list'], async () => {
    const approvalRequired = new Set(toolRegistry.getApprovalRequired())
    return toolRegistry.getDefinitions().map(d => ({
      name: d.name,
      description: d.description,
      isReadOnly: toolRegistry.isReadOnly(d.name),
      requiresApproval: approvalRequired.has(d.name),
    }))
  })

  ipcMain.handle(IPC_CHANNELS['system:doctor'], async () => {
    const { Doctor } = await import('../diagnostics/doctor')
    const apiKey = settingsManager.getApiKey(settingsManager.getSettings().provider)
    const checks = await Doctor.run({
      mcpManager,
      apiKeyConfigured: !!apiKey,
      provider: settingsManager.getSettings().provider,
      model: settingsManager.getSettings().model,
    })
    return Doctor.formatResults(checks)
  })
}
