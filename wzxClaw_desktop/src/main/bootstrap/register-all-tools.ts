// ============================================================
// Bootstrap Stage 3 — register-all-tools
// 向 ToolRegistry 注册所有运行时工具，并绑定浏览器 / HandBridge 事件转发
// ============================================================

import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { EnterPlanModeTool, ExitPlanModeTool } from '../tools/plan-mode'
import {
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserScreenshotTool,
  BrowserEvaluateTool,
  BrowserCloseTool,
} from '../tools/browser-tools'
import type { CoreManagers } from './create-core-managers'
import type { InitialServices } from './init-services'

type Deps = CoreManagers & Pick<InitialServices, 'settingsManager' | 'browserManager'>

export async function registerAllTools(deps: Deps): Promise<void> {
  const {
    toolRegistry, permissionManager, planModeController, askUserTool,
    mcpManager, hookRegistry, handBridge, browserManager, settingsManager,
  } = deps

  const getWebContents = () => BrowserWindow.getAllWindows()[0]?.webContents ?? null

  // Plan-mode 工具需要一个能向 renderer 发送事件的 WebContents 包装
  const getPlanModeSender = (): Electron.WebContents | null => {
    const wc = getWebContents()
    if (!wc) return null
    return {
      isDestroyed: () => wc.isDestroyed(),
      send: (channel: string, ...args: unknown[]) => { wc.send(channel, ...args) },
    } as unknown as Electron.WebContents
  }

  toolRegistry.register(new EnterPlanModeTool(permissionManager, getPlanModeSender))
  toolRegistry.register(new ExitPlanModeTool(permissionManager, getPlanModeSender, planModeController))
  toolRegistry.register(askUserTool)

  // MCP 资源工具（MCPManager 创建后注入，避免循环依赖）
  const { MCPListResourcesTool, MCPReadResourceTool } = await import('../tools/mcp-resource-tool')
  toolRegistry.register(new MCPListResourcesTool(mcpManager))
  toolRegistry.register(new MCPReadResourceTool(mcpManager))

  // 插件注册表联动 Hook + MCP
  const { pluginRegistry } = await import('../plugins')
  pluginRegistry.setSettingsManager(settingsManager)
  pluginRegistry.setHookRegistry(hookRegistry)
  pluginRegistry.setMcpManager(mcpManager)

  // 浏览器自动化工具
  toolRegistry.register(new BrowserNavigateTool(browserManager))
  toolRegistry.register(new BrowserClickTool(browserManager))
  toolRegistry.register(new BrowserTypeTool(browserManager))
  toolRegistry.register(new BrowserScreenshotTool(browserManager))
  toolRegistry.register(new BrowserEvaluateTool(browserManager))
  toolRegistry.register(new BrowserCloseTool(browserManager))

  // 浏览器事件 → renderer 转发
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

  // HandBridge 状态变更 → renderer 推送
  handBridge.onStatusChange((status) => {
    for (const bw of BrowserWindow.getAllWindows()) {
      bw.webContents.send(IPC_CHANNELS['hand:status'], {
        status: String(status),
        handId: handBridge.getHandId(),
      })
    }
  })
}
