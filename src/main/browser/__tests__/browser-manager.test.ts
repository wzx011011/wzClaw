import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock playwright-core — factory must not reference outer variables (hoisting)
const mockPage = {
  goto: vi.fn().mockResolvedValue(undefined),
  title: vi.fn().mockResolvedValue('Test Page'),
  click: vi.fn().mockResolvedValue(undefined),
  fill: vi.fn().mockResolvedValue(undefined),
  screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  evaluate: vi.fn().mockResolvedValue({ result: 'ok' }),
  url: vi.fn().mockReturnValue('https://example.com'),
  waitForTimeout: vi.fn().mockResolvedValue(undefined)
}

const mockContext = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined)
}

const mockBrowserInstance = {
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn().mockResolvedValue(undefined)
}

vi.mock('playwright-core', () => {
  return {
    chromium: {
      launch: vi.fn().mockImplementation(async () => mockBrowserInstance)
    }
  }
})

vi.mock('fs', () => ({
  default: { existsSync: vi.fn().mockReturnValue(false) },
  existsSync: vi.fn().mockReturnValue(false)
}))

import { BrowserManager } from '../browser-manager'

describe('BrowserManager', () => {
  let manager: BrowserManager

  beforeEach(() => {
    manager = new BrowserManager()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await manager.close()
  })

  describe('initial state', () => {
    it('isRunning is false before launch', () => {
      expect(manager.isRunning).toBe(false)
    })

    it('currentUrl is null before launch', () => {
      expect(manager.currentUrl).toBe(null)
    })
  })

  describe('launch', () => {
    it('launches Chromium and creates page', async () => {
      const statusSpy = vi.fn()
      manager.on('status', statusSpy)

      await manager.launch()

      expect(manager.isRunning).toBe(true)
      expect(mockBrowserInstance.newContext).toHaveBeenCalledWith({
        viewport: { width: 1280, height: 720 }
      })
      expect(mockContext.newPage).toHaveBeenCalled()
      expect(statusSpy).toHaveBeenCalledWith(
        expect.objectContaining({ running: true })
      )
    })

    it('does not re-launch if already running', async () => {
      await manager.launch()
      await manager.launch()

      const { chromium } = await import('playwright-core')
      expect(chromium.launch).toHaveBeenCalledTimes(1)
    })
  })

  describe('navigate', () => {
    it('navigates and returns page title', async () => {
      await manager.launch()
      const title = await manager.navigate('https://example.com')

      expect(title).toBe('Test Page')
      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })
    })

    it('emits screenshot after navigation', async () => {
      const screenshotSpy = vi.fn()
      manager.on('screenshot', screenshotSpy)

      await manager.launch()
      await manager.navigate('https://example.com')

      expect(screenshotSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          base64: expect.any(String),
          url: 'https://example.com',
          timestamp: expect.any(Number)
        })
      )
    })

    it('auto-launches if not running', async () => {
      await manager.navigate('https://example.com')
      expect(manager.isRunning).toBe(true)
    })
  })

  describe('click', () => {
    it('clicks element and takes screenshot', async () => {
      const screenshotSpy = vi.fn()
      manager.on('screenshot', screenshotSpy)

      await manager.launch()
      await manager.click('#btn')

      expect(mockPage.click).toHaveBeenCalledWith('#btn', { timeout: 10000 })
      expect(mockPage.waitForTimeout).toHaveBeenCalledWith(500)
      expect(screenshotSpy).toHaveBeenCalled()
    })
  })

  describe('type', () => {
    it('fills input and takes screenshot', async () => {
      await manager.launch()
      await manager.type('#input', 'hello')

      expect(mockPage.fill).toHaveBeenCalledWith('#input', 'hello', { timeout: 10000 })
    })
  })

  describe('screenshot', () => {
    it('returns base64 and emits event', async () => {
      const screenshotSpy = vi.fn()
      manager.on('screenshot', screenshotSpy)

      await manager.launch()
      const base64 = await manager.screenshot()

      expect(typeof base64).toBe('string')
      expect(screenshotSpy).toHaveBeenCalledWith(
        expect.objectContaining({ base64 })
      )
    })
  })

  describe('evaluate', () => {
    it('evaluates JS and returns stringified result', async () => {
      await manager.launch()
      const result = await manager.evaluate('document.title')

      expect(mockPage.evaluate).toHaveBeenCalledWith('document.title')
      expect(result).toContain('result')
    })

    it('returns string result directly', async () => {
      mockPage.evaluate.mockResolvedValueOnce('plain string')
      await manager.launch()
      const result = await manager.evaluate('1+1')
      expect(result).toBe('plain string')
    })
  })

  describe('close', () => {
    it('closes context and browser', async () => {
      await manager.launch()
      await manager.close()

      expect(mockContext.close).toHaveBeenCalled()
      expect(mockBrowserInstance.close).toHaveBeenCalled()
      expect(manager.isRunning).toBe(false)
    })

    it('emits status with running=false', async () => {
      await manager.launch()
      const statusSpy = vi.fn()
      manager.on('status', statusSpy)
      await manager.close()

      expect(statusSpy).toHaveBeenCalledWith(
        expect.objectContaining({ running: false, url: null })
      )
    })

    it('handles close when not running', async () => {
      await expect(manager.close()).resolves.toBeUndefined()
    })
  })
})
