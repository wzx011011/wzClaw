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
  private mode: PermissionMode
  private readonly approvalHandler?: (toolName: string, toolInput: Record<string, unknown>) => Promise<boolean>
  private readonly sessionApprovals = new Map<string, Set<string>>()
  private readonly alwaysAllowRules = new Set<string>()
  private planModeActive = false

  /** 只读工具集合（plan 模式下允许） */
  private static readonly READ_ONLY_TOOLS = new Set([
    'FileRead', 'FileList', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
    'SemanticSearch', 'GoToDefinition', 'FindReferences', 'SearchSymbols',
    'CreateTask', 'UpdateTask', 'TodoWrite',
  ])

  private static readonly FILE_TOOLS = new Set(['FileWrite', 'FileEdit'])

  private static readonly PLAN_MODE_WRITE_TOOLS = new Set([
    'FileWrite', 'FileEdit', 'Bash', 'BashCommand',
  ])

  constructor(
    mode: PermissionMode = 'bypass',
    approvalHandler?: (toolName: string, toolInput: Record<string, unknown>) => Promise<boolean>,
  ) {
    this.mode = mode
    this.approvalHandler = approvalHandler
  }

  getMode(): PermissionMode {
    return this.mode
  }

  setMode(mode: string): void {
    if (['always-ask', 'accept-edits', 'plan', 'bypass'].includes(mode)) {
      this.mode = mode as PermissionMode
    }
  }

  cycleMode(): PermissionMode {
    const modes: PermissionMode[] = ['always-ask', 'accept-edits', 'plan', 'bypass']
    const index = modes.indexOf(this.mode)
    this.mode = modes[(index + 1) % modes.length]
    return this.mode
  }

  needsApproval(toolName: string, toolInput?: Record<string, unknown>): boolean {
    if (this.planModeActive) {
      return PermissionManager.PLAN_MODE_WRITE_TOOLS.has(toolName)
    }

    if (this.alwaysAllowRules.has(toolName)) return false
    if ((toolName === 'Bash' || toolName === 'BashCommand') && toolInput?.command) {
      const prefix = this.extractCommandPrefix(String(toolInput.command))
      if (prefix && this.alwaysAllowRules.has(`${toolName}:${prefix}`)) return false
      if (prefix && this.alwaysAllowRules.has(`Bash:${prefix}`)) return false
    }

    switch (this.mode) {
      case 'bypass':
        return false
      case 'accept-edits':
        return !PermissionManager.READ_ONLY_TOOLS.has(toolName) && !PermissionManager.FILE_TOOLS.has(toolName)
      case 'plan':
        // 只有只读工具允许
        return !PermissionManager.READ_ONLY_TOOLS.has(toolName)
      case 'always-ask':
        return true
    }
  }

  async requestApproval(
    conversationId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.needsApproval(toolName, toolInput)) return true

    const approvedForSession = this.sessionApprovals.get(conversationId)
    if (approvedForSession?.has(toolName)) return true

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
    if (!this.planModeActive && this.mode !== 'plan') return null
    if (PermissionManager.READ_ONLY_TOOLS.has(toolName)) return null
    return `Plan 模式下不允许执行写操作: ${toolName}`
  }

  setPlanMode(active: boolean): void {
    this.planModeActive = active
  }

  isPlanMode(): boolean {
    return this.planModeActive
  }

  clearSession(conversationId: string): void {
    this.sessionApprovals.delete(conversationId)
  }

  getAlwaysAllowRules(): string[] {
    return Array.from(this.alwaysAllowRules)
  }

  loadAlwaysAllowRules(rules: string[] = []): void {
    this.alwaysAllowRules.clear()
    for (const rule of rules) {
      if (rule) this.alwaysAllowRules.add(rule)
    }
  }

  private extractCommandPrefix(command: string): string {
    const cleaned = command.replace(/^(\w+=\S+\s+)*/, '').trim()
    const words = cleaned.split(/\s+/)
    const shellPrefixes = new Set(['bash', 'sh', 'zsh', 'sudo', 'xargs', 'env'])
    let start = 0
    while (start < words.length && shellPrefixes.has(words[start])) {
      start += 1
    }
    return words.slice(start, start + 2).join(' ')
  }
}
