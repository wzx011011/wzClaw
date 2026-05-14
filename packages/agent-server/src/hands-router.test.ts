// ============================================================
// hands-router.ts 测试 — Hand 注册、路由、健康检查
// ============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HandsRouter } from './hands-router.js'
import type { HandEntry } from './hands-router.js'

// ---- 测试辅助 ----

/** 创建 mock WebSocket 对象 */
function mockWs(): any {
  return {
    readyState: 1, // WebSocket.OPEN
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    ping: vi.fn(),
  }
}

/** 创建 HandEntry */
function makeHand(overrides: Partial<HandEntry> & { id: string }): HandEntry {
  return {
    ws: mockWs(),
    id: overrides.id,
    capabilities: overrides.capabilities ?? [],
    definitions: overrides.definitions ?? [],
    lastHeartbeat: overrides.lastHeartbeat ?? Date.now(),
    priority: overrides.priority ?? 0,
  }
}

// ---- 测试 ----

describe('HandsRouter', () => {
  let router: HandsRouter

  beforeEach(() => {
    router = new HandsRouter()
  })

  describe('register / unregister', () => {
    it('register(hand) 添加 Hand 到路由表，getHandCount() 增加', () => {
      const hand = makeHand({ id: 'hand-1', capabilities: ['FileRead'] })
      expect(router.getHandCount()).toBe(0)

      router.register(hand)
      expect(router.getHandCount()).toBe(1)

      router.register(makeHand({ id: 'hand-2', capabilities: ['FileWrite'] }))
      expect(router.getHandCount()).toBe(2)
    })

    it('unregister(handId) 移除 Hand，getHandCount() 减少', () => {
      const hand = makeHand({ id: 'hand-1', capabilities: ['FileRead'] })
      router.register(hand)
      expect(router.getHandCount()).toBe(1)

      router.unregister('hand-1')
      expect(router.getHandCount()).toBe(0)
    })

    it('unregister 不存在的 handId 无副作用', () => {
      router.unregister('不存在')
      expect(router.getHandCount()).toBe(0)
    })

    it('register 分配自增 priority', () => {
      const hand1 = makeHand({ id: 'h1', capabilities: ['A'] })
      const hand2 = makeHand({ id: 'h2', capabilities: ['B'] })
      const hand3 = makeHand({ id: 'h3', capabilities: ['C'] })

      router.register(hand1)
      router.register(hand2)
      router.register(hand3)

      // 先注册的 priority 更小 → 优先级更高
      expect(hand1.priority).toBeLessThan(hand2.priority)
      expect(hand2.priority).toBeLessThan(hand3.priority)
    })

    it('重复 register 同一个 handId 覆盖旧条目但保留更高 priority', () => {
      const hand1 = makeHand({ id: 'h1', capabilities: ['A'] })
      router.register(hand1)
      const firstPriority = hand1.priority

      const hand1New = makeHand({ id: 'h1', capabilities: ['B'] })
      router.register(hand1New)

      // 覆盖后 count 不变
      expect(router.getHandCount()).toBe(1)
      // 新条目沿用旧 priority（先注册优先）
      expect(hand1New.priority).toBe(firstPriority)
    })
  })

  describe('findHand', () => {
    it('findHand("FileRead") 返回注册了 FileRead 工具的 Hand', () => {
      const hand = makeHand({
        id: 'hand-1',
        capabilities: ['FileRead', 'FileWrite'],
      })
      router.register(hand)

      const found = router.findHand('FileRead')
      expect(found).not.toBeNull()
      expect(found!.id).toBe('hand-1')
    })

    it('findHand("不存在") 返回 null', () => {
      const hand = makeHand({ id: 'hand-1', capabilities: ['FileRead'] })
      router.register(hand)

      expect(router.findHand('Grep')).toBeNull()
    })

    it('多个 Hand 注册同名工具时返回优先级高的（先注册的优先）', () => {
      const hand1 = makeHand({ id: 'h1', capabilities: ['FileRead'] })
      const hand2 = makeHand({ id: 'h2', capabilities: ['FileRead'] })

      router.register(hand1) // 先注册 → 优先级高
      router.register(hand2)

      const found = router.findHand('FileRead')
      expect(found).not.toBeNull()
      expect(found!.id).toBe('h1')
    })

    it('不健康的 Hand 不会被 findHand 返回', () => {
      const hand = makeHand({
        id: 'hand-1',
        capabilities: ['FileRead'],
        lastHeartbeat: Date.now() - 60000, // 60s 前心跳 → 超过 30s 超时
      })
      router.register(hand)

      expect(router.findHand('FileRead')).toBeNull()
    })

    it('findHand 跳过不健康的 Hand，返回下一个健康的', () => {
      const hand1 = makeHand({
        id: 'h1',
        capabilities: ['FileRead'],
        lastHeartbeat: Date.now() - 60000, // 不健康
      })
      const hand2 = makeHand({
        id: 'h2',
        capabilities: ['FileRead'],
        lastHeartbeat: Date.now(), // 健康
      })

      router.register(hand1)
      router.register(hand2)

      const found = router.findHand('FileRead')
      expect(found).not.toBeNull()
      expect(found!.id).toBe('h2')
    })

    it('没有注册任何 Hand 时 findHand 返回 null', () => {
      expect(router.findHand('FileRead')).toBeNull()
    })
  })

  describe('getHandById', () => {
    it('返回指定 ID 的 Hand', () => {
      const hand = makeHand({ id: 'h1', capabilities: ['A'] })
      router.register(hand)

      const found = router.getHandById('h1')
      expect(found).not.toBeUndefined()
      expect(found!.id).toBe('h1')
    })

    it('不存在时返回 undefined', () => {
      expect(router.getHandById('不存在')).toBeUndefined()
    })
  })

  describe('getAllDefinitions', () => {
    it('返回所有在线 Hand 的工具定义', () => {
      const hand1 = makeHand({
        id: 'h1',
        capabilities: ['FileRead'],
        definitions: [
          { name: 'FileRead', description: '读取文件', inputSchema: {}, isReadOnly: true },
        ],
      })
      const hand2 = makeHand({
        id: 'h2',
        capabilities: ['FileWrite'],
        definitions: [
          { name: 'FileWrite', description: '写入文件', inputSchema: {}, isReadOnly: false },
        ],
      })

      router.register(hand1)
      router.register(hand2)

      const defs = router.getAllDefinitions()
      expect(defs).toHaveLength(2)
      expect(defs.map(d => d.name)).toContain('FileRead')
      expect(defs.map(d => d.name)).toContain('FileWrite')
    })

    it('同名工具去重，保留优先级最高的（先注册的）', () => {
      const hand1 = makeHand({
        id: 'h1',
        capabilities: ['FileRead'],
        definitions: [
          { name: 'FileRead', description: 'Hand1 读取', inputSchema: {}, isReadOnly: true },
        ],
      })
      const hand2 = makeHand({
        id: 'h2',
        capabilities: ['FileRead'],
        definitions: [
          { name: 'FileRead', description: 'Hand2 读取', inputSchema: {}, isReadOnly: true },
        ],
      })

      router.register(hand1) // 先注册 → 优先级高
      router.register(hand2)

      const defs = router.getAllDefinitions()
      expect(defs).toHaveLength(1)
      expect(defs[0].description).toBe('Hand1 读取')
    })

    it('不健康 Hand 的定义不包含在结果中', () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['FileRead'],
        definitions: [
          { name: 'FileRead', description: '读取文件', inputSchema: {}, isReadOnly: true },
        ],
        lastHeartbeat: Date.now() - 60000, // 不健康
      })
      router.register(hand)

      const defs = router.getAllDefinitions()
      expect(defs).toHaveLength(0)
    })

    it('无 Hand 时返回空数组', () => {
      expect(router.getAllDefinitions()).toEqual([])
    })
  })

  describe('updateHeartbeat', () => {
    it('更新 lastHeartbeat 使不健康的 Hand 恢复健康', () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['FileRead'],
        lastHeartbeat: Date.now() - 60000, // 不健康
      })
      router.register(hand)

      // 确认不健康
      expect(router.findHand('FileRead')).toBeNull()

      // 更新心跳
      router.updateHeartbeat('h1')

      // 现在应该健康了
      const found = router.findHand('FileRead')
      expect(found).not.toBeNull()
      expect(found!.id).toBe('h1')
    })

    it('不存在的 handId 无副作用', () => {
      router.updateHeartbeat('不存在') // 不抛异常
    })
  })

  describe('checkHealth', () => {
    it('30s 内有心跳的 Hand 视为健康', () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['A'],
        lastHeartbeat: Date.now() - 10000, // 10s 前 → 健康
      })
      router.register(hand)

      router.checkHealth()
      expect(router.getHandById('h1')).toBeDefined()
    })

    it('超过 30s 无心跳的 Hand 标记为不健康（不删除）', () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['A'],
        lastHeartbeat: Date.now() - 31000, // 31s 前 → 超时
      })
      router.register(hand)

      router.checkHealth()
      // Hand 仍在路由表中
      expect(router.getHandCount()).toBe(1)
      // 但 findHand 不会返回它
      expect(router.findHand('A')).toBeNull()
    })

    it('可自定义超时时间', () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['A'],
        lastHeartbeat: Date.now() - 5000, // 5s 前
      })
      router.register(hand)

      // 3s 超时 → 5s 前的心跳已超时
      router.checkHealth(3000)
      expect(router.findHand('A')).toBeNull()
    })
  })

  describe('isHealthy', () => {
    it('心跳在 30s 内返回 true', () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['A'],
        lastHeartbeat: Date.now(),
      })
      router.register(hand)

      expect(router.isHealthy(hand)).toBe(true)
    })

    it('心跳超过 30s 返回 false', () => {
      const hand = makeHand({
        id: 'h1',
        capabilities: ['A'],
        lastHeartbeat: Date.now() - 31000,
      })
      router.register(hand)

      expect(router.isHealthy(hand)).toBe(false)
    })
  })
})
