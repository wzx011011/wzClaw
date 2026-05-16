// ============================================================
// HookRegistry 单元测试
// ============================================================

import { describe, it, expect, vi } from 'vitest'
import { HookRegistry } from '../hook-registry.js'
import { registerBuiltInHooks } from '../built-in-hooks.js'
import type { HookContext, HookResult } from '../hook-registry.js'

describe('HookRegistry', () => {
  it('register + emit 触发 handler', async () => {
    const registry = new HookRegistry()
    const handler = vi.fn().mockResolvedValue(undefined)

    registry.register({ id: 'test', event: 'pre-tool', handler })
    await registry.emit('pre-tool', { toolName: 'FileRead' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0].toolName).toBe('FileRead')
  })

  it('emit 聚合 preventContinuation', async () => {
    const registry = new HookRegistry()

    registry.register({
      id: 'stop',
      event: 'turn-end',
      handler: async () => ({ preventContinuation: true }),
      priority: 1,
    })

    const result = await registry.emit('turn-end', {})
    expect(result.preventContinuation).toBe(true)
  })

  it('emit 聚合 blockingError', async () => {
    const registry = new HookRegistry()

    registry.register({
      id: 'warn',
      event: 'turn-end',
      handler: async () => ({ blockingError: '停滞检测' }),
    })

    const result = await registry.emit('turn-end', {})
    expect(result.blockingError).toBe('停滞检测')
  })

  it('unregister 移除 hook', async () => {
    const registry = new HookRegistry()
    const handler = vi.fn().mockResolvedValue(undefined)

    registry.register({ id: 'removable', event: 'pre-tool', handler })
    registry.unregister('removable')
    await registry.emit('pre-tool', { toolName: 'Test' })

    expect(handler).not.toHaveBeenCalled()
  })

  it('hook timeout 不阻塞其他 hook', async () => {
    const registry = new HookRegistry()
    const fastHandler = vi.fn().mockResolvedValue(undefined)

    registry.register({
      id: 'slow',
      event: 'pre-tool',
      handler: async () => new Promise(() => {}), // 永不 resolve
      timeout: 50,
    })
    registry.register({ id: 'fast', event: 'pre-tool', handler: fastHandler, priority: 2 })

    const result = await registry.emit('pre-tool', { toolName: 'Test' })
    expect(fastHandler).toHaveBeenCalled()
    expect(result).toEqual({}) // slow hook 超时，不返回结果
  }, 10000)

  it('priority 排序 — 数字小先执行', async () => {
    const registry = new HookRegistry()
    const order: string[] = []

    registry.register({
      id: 'second',
      event: 'post-tool',
      handler: async () => { order.push('second') },
      priority: 20,
    })
    registry.register({
      id: 'first',
      event: 'post-tool',
      handler: async () => { order.push('first') },
      priority: 10,
    })

    await registry.emit('post-tool', {})
    expect(order).toEqual(['first', 'second'])
  })
})

describe('registerBuiltInHooks', () => {
  it('注册至少 8 个内置 hook', () => {
    const registry = new HookRegistry()
    registerBuiltInHooks(registry)

    const hooks = registry.getHooks()
    expect(hooks.length).toBeGreaterThanOrEqual(8)
  })

  it('内置 hook 可正常 emit', async () => {
    const registry = new HookRegistry()
    registerBuiltInHooks(registry)

    // 不应抛出错误
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await registry.emit('pre-tool', { toolName: 'FileRead' })
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})
