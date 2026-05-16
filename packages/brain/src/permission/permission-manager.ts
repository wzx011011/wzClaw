// ============================================================
// PermissionManager — 权限管理实现
//
// 实现 IPermissionManager 接口。
// Brain 运行在服务器端，默认 bypass 模式（所有工具自动批准）。
// 桌面端可注入 UI 弹窗实现覆盖。
// ============================================================

import type { IPermissionManager } from '../interfaces.js'

/** 权限模式 */
export type PermissionMode = 'always-ask' | 'accept-edits' | 'plan' | 'bypass'

/**
 * PermissionManager — 服务器端默认实现
 *
 * 默认 bypass 模式：所有工具自动批准。
 * 桌面端可通过构造函数注入不同的 mode 和 approvalHandler。
 */
export class PermissionManager implements IPermissionManager {
  private readonly mode: PermissionMode
  private readonly approvalHandler?: (toolName: string, toolInput: Record<string, unknown>) => Promise<boolean>

  /** 只读工具集合（plan 模式下允许） */
  private static readonly READ_ONLY_TOOLS = new Set([
    'FileRead', 'FileList', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
  ])

  constructor(
    mode: PermissionMode = 'bypass',
    approvalHandler?: (toolName: string, toolInput: Record<string, unknown>) => Promise<boolean>,
  ) {
    this.mode = mode
    this.approvalHandler = approvalHandler
  }

  needsApproval(toolName: string, _toolInput?: Record<string, unknown>): boolean {
    switch (this.mode) {
      case 'bypass':
        return false
      case 'accept-edits':
        // 写操作需要批准（但实际 auto-approve）
        return !PermissionManager.READ_ONLY_TOOLS.has(toolName)
      case 'plan':
        // 只有只读工具允许
        return !PermissionManager.READ_ONLY_TOOLS.has(toolName)
      case 'always-ask':
        return true
    }
  }

  async requestApproval(
    _conversationId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<boolean> {
    // bypass 和 accept-edits 自动批准
    if (this.mode === 'bypass' || this.mode === 'accept-edits') {
      return true
    }

    // plan 模式：只读工具批准，其他拒绝
    if (this.mode === 'plan') {
      return PermissionManager.READ_ONLY_TOOLS.has(toolName)
    }

    // always-ask：调用外部处理器（桌面端 UI 弹窗）
    if (this.approvalHandler) {
      return this.approvalHandler(toolName, toolInput)
    }

    // 无处理器时默认批准
    return true
  }

  getPlanModeRejection(toolName: string): string | null {
    if (this.mode !== 'plan') return null
    if (PermissionManager.READ_ONLY_TOOLS.has(toolName)) return null
    return `Plan 模式下不允许执行写操作: ${toolName}`
  }
}
