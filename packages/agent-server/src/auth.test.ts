// ============================================================
// auth.ts 测试 — Token 认证模块
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initAuth, authenticate, _resetAuthState } from './auth.js'

describe('auth 模块', () => {
  // 每个测试前重置状态和环境变量
  const originalAuthToken = process.env.AUTH_TOKEN

  beforeEach(() => {
    _resetAuthState()
    delete process.env.AUTH_TOKEN
  })

  afterEach(() => {
    _resetAuthState()
    // 恢复原始环境变量
    if (originalAuthToken !== undefined) {
      process.env.AUTH_TOKEN = originalAuthToken
    } else {
      delete process.env.AUTH_TOKEN
    }
  })

  describe('开发模式（未设 AUTH_TOKEN）', () => {
    it('initAuth() 未设 AUTH_TOKEN 时进入 dev mode，authenticate 任意非空 token 返回 ok', () => {
      initAuth()
      const result = authenticate('any-random-token')
      expect(result.ok).toBe(true)
      expect(result.reason).toBe('')
    })

    it('dev mode 下 authenticate 不同 token 都返回 ok', () => {
      initAuth()
      expect(authenticate('token-1').ok).toBe(true)
      expect(authenticate('token-2').ok).toBe(true)
      expect(authenticate('hello-world').ok).toBe(true)
    })
  })

  describe('生产模式（设 AUTH_TOKEN）', () => {
    it('AUTH_TOKEN=abc 时 authenticate("abc") 返回 ok', () => {
      process.env.AUTH_TOKEN = 'abc'
      initAuth()
      const result = authenticate('abc')
      expect(result.ok).toBe(true)
      expect(result.reason).toBe('')
    })

    it('AUTH_TOKEN=abc 时 authenticate("wrong") 返回拒绝', () => {
      process.env.AUTH_TOKEN = 'abc'
      initAuth()
      const result = authenticate('wrong')
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('invalid token')
    })

    it('AUTH_TOKEN 设置时 authenticate 空字符串返回拒绝', () => {
      process.env.AUTH_TOKEN = 'abc'
      initAuth()
      const result = authenticate('')
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('missing token')
    })

    it('AUTH_TOKEN 设置时 authenticate(null) 返回拒绝', () => {
      process.env.AUTH_TOKEN = 'abc'
      initAuth()
      const result = authenticate(null)
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('missing token')
    })

    it('AUTH_TOKEN 设置时 authenticate(undefined) 返回拒绝', () => {
      process.env.AUTH_TOKEN = 'abc'
      initAuth()
      const result = authenticate(undefined)
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('missing token')
    })
  })

  describe('边界情况', () => {
    it('未调用 initAuth() 但 AUTH_TOKEN 已设置时，authenticate 仍可验证（直接读环境变量）', () => {
      // _resetAuthState 已在 beforeEach 调用，_devMode=false
      // 设置 AUTH_TOKEN 后直接 authenticate 也能正常工作
      process.env.AUTH_TOKEN = 'secret'
      const result = authenticate('secret')
      expect(result.ok).toBe(true)
      // 错误的 token 被拒绝
      expect(authenticate('wrong').ok).toBe(false)
    })

    it('纯空白格 token 视为 missing', () => {
      process.env.AUTH_TOKEN = 'abc'
      initAuth()
      const result = authenticate('   ')
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('missing token')
    })

    it('dev mode 下 null/undefined 仍然被拒绝（missing token）', () => {
      initAuth()
      expect(authenticate(null).ok).toBe(false)
      expect(authenticate(null).reason).toBe('missing token')
      expect(authenticate(undefined).ok).toBe(false)
      expect(authenticate(undefined).reason).toBe('missing token')
      expect(authenticate('').ok).toBe(false)
      expect(authenticate('').reason).toBe('missing token')
    })
  })
})
