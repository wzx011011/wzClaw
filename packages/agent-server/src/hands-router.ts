// ============================================================
// Hand 路由器 — 管理 Hand 连接的注册、路由、健康检查
// HandsRouter 维护所有在线 Hand 的路由表，支持按工具名查找、
// 优先级排序、心跳健康检查
// ============================================================

import type { WebSocket } from 'ws'

/** 工具定义（含 isReadOnly 标记） */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  isReadOnly?: boolean
}

/** 路由表中的 Hand 条目 */
export interface HandEntry {
  /** WebSocket 连接 */
  ws: WebSocket
  /** Hand 唯一标识符 */
  id: string
  /** 该 Hand 支持的工具名列表 */
  capabilities: string[]
  /** 完整工具定义 */
  definitions: ToolDefinition[]
  /** 最近一次心跳时间戳 */
  lastHeartbeat: number
  /** 优先级（注册顺序，越小越高） */
  priority: number
}

/** 默认心跳超时时间（30s） */
const DEFAULT_HEARTBEAT_TIMEOUT = 30_000

/**
 * Hand 路由器
 *
 * 管理 Hand 连接的注册/注销，按工具名查找对应的 Hand，
 * 健康检查排除心跳超时的 Hand。
 * 同名工具冲突时，先注册的优先（priority 更小）。
 */
export class HandsRouter {
  /** 路由表 handId → HandEntry */
  private readonly hands = new Map<string, HandEntry>()

  /** 下一个分配的 priority 值（自增） */
  private nextPriority = 0

  /** 当前健康检查超时阈值（由 checkHealth 更新） */
  private healthTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT

  /**
   * 注册 Hand 到路由表
   * 如果 handId 已存在，覆盖旧条目但保留原始 priority
   * 注意：会修改传入 entry 的 priority 属性
   */
  register(entry: Omit<HandEntry, 'priority'> & { priority?: number }): void {
    const existing = this.hands.get(entry.id)
    // 保留已注册的 priority（先注册优先），新条目分配新 priority
    const priority = existing ? existing.priority : this.nextPriority++
    // 直接在传入对象上设置 priority，确保调用者可见
    ;(entry as HandEntry).priority = priority
    this.hands.set(entry.id, entry as HandEntry)
  }

  /**
   * 注销 Hand
   * 从路由表中移除指定 handId
   */
  unregister(handId: string): void {
    this.hands.delete(handId)
  }

  /**
   * 按工具名查找能执行该工具的健康 Hand
   * 多个 Hand 都支持时返回优先级最高的（priority 最小）
   */
  findHand(toolName: string): HandEntry | null {
    let best: HandEntry | null = null
    for (const entry of this.hands.values()) {
      if (!this.isHealthy(entry)) continue
      if (!entry.capabilities.includes(toolName)) continue
      if (best === null || entry.priority < best.priority) {
        best = entry
      }
    }
    return best
  }

  /**
   * 按 handId 查找 Hand 条目
   */
  getHandById(handId: string): HandEntry | undefined {
    return this.hands.get(handId)
  }

  /**
   * 获取所有在线健康 Hand 的工具定义（去重）
   * 同名工具保留优先级最高的定义
   */
  getAllDefinitions(): ToolDefinition[] {
    const seen = new Map<string, ToolDefinition>()

    // 先按 priority 排序，优先级高的在前
    const sorted = [...this.hands.values()].sort((a, b) => a.priority - b.priority)

    for (const entry of sorted) {
      if (!this.isHealthy(entry)) continue
      for (const def of entry.definitions) {
        if (!seen.has(def.name)) {
          seen.set(def.name, def)
        }
      }
    }

    return [...seen.values()]
  }

  /**
   * 获取当前注册的 Hand 数量（包含不健康的）
   */
  getHandCount(): number {
    return this.hands.size
  }

  /**
   * 获取所有已注册的 Hand 条目
   */
  getAllHands(): HandEntry[] {
    return Array.from(this.hands.values())
  }

  /**
   * 更新指定 Hand 的心跳时间
   */
  updateHeartbeat(handId: string): void {
    const entry = this.hands.get(handId)
    if (entry) {
      entry.lastHeartbeat = Date.now()
    }
  }

  /**
   * 检查所有 Hand 的健康状态
   * 更新内部健康检查超时阈值，后续 isHealthy/findHand/getAllDefinitions 使用该阈值
   * 超时的 Hand 不会被移除，只是 isHealthy 返回 false
   */
  checkHealth(timeoutMs: number = DEFAULT_HEARTBEAT_TIMEOUT): void {
    this.healthTimeoutMs = timeoutMs
  }

  /**
   * 判断 Hand 是否健康（心跳在超时窗口内）
   * 使用当前 healthTimeoutMs 阈值（由 checkHealth 更新）
   */
  isHealthy(entry: HandEntry, timeoutMs?: number): boolean {
    const timeout = timeoutMs ?? this.healthTimeoutMs
    return Date.now() - entry.lastHeartbeat <= timeout
  }
}
