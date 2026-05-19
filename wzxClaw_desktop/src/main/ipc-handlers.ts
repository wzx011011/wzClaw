// ============================================================
// IPC Handlers — thin orchestrator
// 拆分到 ./ipc-handlers/ 子目录下的各 domain handler 文件
// ============================================================

import type { PermissionManager } from '@wzxclaw/brain'
import type { WorkspaceManager } from './workspace/workspace-manager'
import type { TerminalManager } from './terminal/terminal-manager'
import type { SettingsManager } from './settings-manager'
import type { IndexingEngine } from './indexing/indexing-engine'
import type { MCPManager } from './mcp/mcp-manager'
import type { WorkspaceStore } from './tasks/workspace-persistence'
import type { HandBridge } from './hand-bridge'
import type { ToolRegistry } from './tools/tool-registry'

// IndexingEngineRef 共享引用类型（从 bootstrap/create-core-managers 传入）
export type IndexingEngineRef = { current: IndexingEngine | null }

// Domain handler groups
import { registerFileIpcHandlers } from './ipc-handlers/file-ipc-handlers'
import { registerSkillIpcHandlers } from './ipc-handlers/skill-ipc-handlers'
import { registerPluginIpcHandlers } from './ipc-handlers/plugin-ipc-handlers'
import { registerSettingsIpcHandlers } from './ipc-handlers/settings-ipc-handlers'
import { registerWorkspaceIpcHandlers } from './ipc-handlers/workspace-ipc-handlers'
import { registerTerminalIpcHandlers } from './ipc-handlers/terminal-ipc-handlers'
import { registerIndexIpcHandlers } from './ipc-handlers/index-ipc-handlers'
import { registerMcpIpcHandlers } from './ipc-handlers/mcp-ipc-handlers'
import { registerHandIpcHandlers } from './ipc-handlers/hand-ipc-handlers'
import { registerPermissionIpcHandlers } from './ipc-handlers/permission-ipc-handlers'

export function registerIpcHandlers(
  permissionManager: PermissionManager,
  workspaceManager: WorkspaceManager,
  terminalManager: TerminalManager,
  indexingEngineRef: IndexingEngineRef,
  settingsManager: SettingsManager,
  mcpManager: MCPManager,
  workspaceStore: WorkspaceStore,
  handBridge: HandBridge,
  toolRegistry: ToolRegistry,
  onWorkspaceOpened?: (rootPath: string) => void,
  onDataChanged?: (event: string, data: unknown) => void,
  _onStreamEvent?: (event: string, data: unknown) => void
): void {

  // Resolve project roots — used by file/skill/plugin handlers
  const resolveProjectRoots = (): string[] => {
    const cwd = workspaceManager.getWorkspaceRoot() ?? process.cwd()
    return [cwd]
  }

  // ---- Register domain handler groups ----
  registerFileIpcHandlers({ workspaceManager })
  registerSkillIpcHandlers({ workspaceManager, settingsManager, resolveProjectRoots })
  registerPluginIpcHandlers({ workspaceManager, settingsManager, resolveProjectRoots })
  registerSettingsIpcHandlers({ settingsManager, onDataChanged })
  registerWorkspaceIpcHandlers({ workspaceManager, workspaceStore, onWorkspaceOpened, onDataChanged })
  registerTerminalIpcHandlers({ terminalManager })
  registerIndexIpcHandlers({ workspaceManager, indexingEngineRef })
  registerMcpIpcHandlers({ mcpManager, toolRegistry, settingsManager })
  registerHandIpcHandlers({ handBridge })
  registerPermissionIpcHandlers({ permissionManager })
}
