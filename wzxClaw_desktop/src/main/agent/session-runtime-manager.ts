// ============================================================
// SessionRuntimeManager — 每个 sessionId 拥有独立的 AgentLoop 实例
//
// 设计目标：
//   - 多会话并发执行（不再因为 cancel + run 单例守卫导致互相 kill）
//   - 共享重对象（gateway / toolRegistry / permissionManager / contextManager
//     / hookRegistry / historyManager）按引用注入，per-runtime 不复制
//   - 轻状态（conversation / abortController / activeWorkspace / turnManager）
//     由 AgentLoop 实例字段天然隔离
//
// 使用：
//   const runtimes = new SessionRuntimeManager(() => new AgentLoop(...))
//   const rt = runtimes.getOrCreate(sessionId)
//   runtimes.notifyRunningChanged(sessionId, true)
//   try { for await (const e of rt.run(...)) { ... } }
//   finally { runtimes.notifyRunningChanged(sessionId, false) }
// ============================================================

import type { AgentLoop } from './agent-loop'

export type RunningChangedListener = (sessionId: string, isRunning: boolean) => void

export class SessionRuntimeManager {
  private runtimes = new Map<string, AgentLoop>()
  private lastActivity = new Map<string, number>()
  private listeners = new Set<RunningChangedListener>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(private factory: () => AgentLoop) {}

  /** 启动定期清理空闲 runtime（默认 5 分钟检查，30 分钟无活动则清理） */
  startIdleCleanup(intervalMs = 5 * 60 * 1000, maxAgeMs = 30 * 60 * 1000): void {
    if (this.cleanupTimer) return
    this.cleanupTimer = setInterval(() => this.deleteIdleRuntimes(maxAgeMs), intervalMs)
  }

  /** 停止定期清理（应用退出时调用） */
  stopIdleCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  /** 清理超过 maxAgeMs 无活动的 runtime */
  deleteIdleRuntimes(maxAgeMs: number): number {
    const now = Date.now()
    let removed = 0
    for (const [id, rt] of this.runtimes) {
      if (rt.isRunning) continue
      const last = this.lastActivity.get(id) ?? 0
      if (now - last > maxAgeMs) {
        rt.cancel()
        this.runtimes.delete(id)
        this.lastActivity.delete(id)
        removed++
      }
    }
    return removed
  }

  /** 获取或创建指定会话的 AgentLoop 实例 */
  getOrCreate(sessionId: string): AgentLoop {
    let rt = this.runtimes.get(sessionId)
    if (!rt) {
      rt = this.factory()
      this.runtimes.set(sessionId, rt)
    }
    this.lastActivity.set(sessionId, Date.now())
    return rt
  }

  /** 获取已存在的实例（不创建） */
  get(sessionId: string): AgentLoop | undefined {
    return this.runtimes.get(sessionId)
  }

  has(sessionId: string): boolean {
    return this.runtimes.has(sessionId)
  }

  isRunning(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.isRunning ?? false
  }

  /** 列出所有当前正在跑的 sessionId */
  listRunning(): string[] {
    const out: string[] = []
    for (const [id, rt] of this.runtimes) {
      if (rt.isRunning) out.push(id)
    }
    return out
  }

  /** 列出所有已加载的 sessionId（含已结束的） */
  listSessions(): string[] {
    return Array.from(this.runtimes.keys())
  }

  /** 取消指定会话的运行 */
  cancel(sessionId: string): void {
    this.runtimes.get(sessionId)?.cancel()
  }

  /** 取消所有正在运行的会话（应用退出 / workspace 切换时调用） */
  cancelAll(): void {
    for (const rt of this.runtimes.values()) rt.cancel()
  }

  /** 移除指定会话的 runtime（先取消） */
  delete(sessionId: string): void {
    const rt = this.runtimes.get(sessionId)
    if (rt) rt.cancel()
    this.runtimes.delete(sessionId)
  }

  /** 清空所有 runtime（workspace 切换时使用） */
  clear(): void {
    this.cancelAll()
    this.runtimes.clear()
    this.lastActivity.clear()
  }

  /** 订阅 running 状态变化（用于 Phase B：广播给 mobile） */
  onRunningChanged(cb: RunningChangedListener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** 由调用方在 run() 入口/出口处显式触发 */
  notifyRunningChanged(sessionId: string, isRunning: boolean): void {
    this.lastActivity.set(sessionId, Date.now())
    for (const cb of this.listeners) {
      try {
        cb(sessionId, isRunning)
      } catch (err) {
        console.error('[SessionRuntimeManager] listener error:', err)
      }
    }
  }
}
