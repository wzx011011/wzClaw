import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Mock electron ---
// Capture the 'closed' event handler so tests can trigger it
let closedHandler: (() => void) | null = null

const mockNativeImage = {
  toPNG: vi.fn().mockReturnValue(Buffer.from('fake-png'))
}

const mockWebContents = {
  getTitle: vi.fn().mockReturnValue('Test Page'),
  getURL: vi.fn().mockReturnValue('https://example.com'),
  executeJavaScript: vi.fn().mockResolvedValue(undefined),
  capturePage: vi.fn().mockResolvedValue(mockNativeImage),
}

const mockWin = {
  loadURL: vi.fn().mockResolvedValue(undefined),
  webContents: mockWebContents,
  isDestroyed: vi.fn().mockReturnValue(false),
  destroy: vi.fn().mockImplementation(() => {
    // Simulate Electron firing the 'closed' event after destroy
    if (closedHandler) closedHandler()
  }),
  on: vi.fn().mockImplementation((event: string, cb: () => void) => {
    if (event === 'closed') closedHandler = cb
  }),
}

vi.mock('electron', () => ({
  BrowserWindow: vi.fn().mockImplementation(() => {
    closedHandler = null
    mockWin.isDestroyed.mockReturnValue(false)
    return mockWin
  })
}))

import { BrowserManager } from '../browser-manager'

describe('BrowserManager', () => {
  let manager: BrowserManager

  beforeEach(() => {
    manager = new BrowserManager()
    vi.clearAllMocks()
    closedHandler = null
    mockWin.isDestroyed.mockReturnValue(false)
  })

  afterEach(async () => {
    await manager.close()
  })

  describe('initial state', () => {
    it('isRunning is false before any operation', () => {
      expect(manager.isRunning).toBe(false)
    })

    it('currentUrl is null before any operation', () => {
      expect(manager.currentUrl).toBe(null)
    })
  })

  describe('navigate', () => {
    it('lazily creates BrowserWindow on first call', async () => {
      const { BrowserWindow } = await import('electron')
      await manager.navigate('https://example.com')
      expect(BrowserWindow).toHaveBeenCalled()
      expect(mockWin.loadURL).toHaveBeenCalledWith('https://example.com')
    })

    it('returns the page title', async () => {
      const title = await manager.navigate('https://example.com')
      expect(title).toBe('Test Page')
    })

    it('emits screenshot event after navigation', async () => {
      const screenshotSpy = vi.fn()
      manager.on('screenshot', screenshotSpy)
      await manager.navigate('https://example.com')
      expect(screenshotSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          base64: expect.any(String),
          url: 'https://example.com',
          timestamp: expect.any(Number)
        })
      )
    })

    it('emits status running=true when window is created', async () => {
      const statusSpy = vi.fn()
      manager.on('status', statusSpy)
      await manager.navigate('https://example.com')
      expect(statusSpy).toHaveBeenCalledWith(
        expect.objectContaining({ running: true })
      )
    })

    it('does not create a second window on repeated calls', async () => {
      const { BrowserWindow } = await import('electron')
      await manager.navigate('https://example.com')
      await manager.navigate('https://example.org')
      expect(BrowserWindow).toHaveBeenCalledTimes(1)
    })
  })

  describe('click', () => {
    it('calls executeJavaScript with selector-based click code', async () => {
      await manager.navigate('https://example.com')
      vi.clearAllMocks()
      await manager.click('#btn')
      expect(mockWebContents.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining('#btn')
      )
    })

    it('emits screenshot after click', async () => {
      await manager.navigate('https://example.com')
      const screenshotSpy = vi.fn()
      manager.on('screenshot', screenshotSpy)
      await manager.click('#btn')
      expect(screenshotSpy).toHaveBeenCalled()
    })
  })

  describe('type', () => {
    it('calls executeJavaScript with selector and text', async () => {
      await manager.navigate('https://example.com')
      vi.clearAllMocks()
      await manager.type('#input', 'hello')
      expect(mockWebContents.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining('#input')
      )
      expect(mockWebContents.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining('hello')
      )
    })
  })

  describe('screenshot', () => {
    it('returns a base64 string via capturePage', async () => {
      await manager.navigate('https://example.com')
      const base64 = await manager.screenshot()
      expect(typeof base64).toBe('string')
      expect(mockNativeImage.toPNG).toHaveBeenCalled()
    })
  })

  describe('evaluate', () => {
    it('executes javascript and returns string result', async () => {
      mockWebContents.executeJavaScript.mockResolvedValueOnce('title text')
      await manager.navigate('https://example.com')
      const result = await manager.evaluate('document.title')
      expect(mockWebContents.executeJavaScript).toHaveBeenCalledWith('document.title')
      expect(result).toBe('title text')
    })

    it('JSON-stringifies non-string results', async () => {
      mockWebContents.executeJavaScript.mockResolvedValueOnce({ result: 'ok' })
      await manager.navigate('https://example.com')
      const result = await manager.evaluate('1+1')
      expect(result).toContain('result')
    })
  })

  describe('close', () => {
    it('destroys the window and sets isRunning to false', async () => {
      await manager.navigate('https://example.com')
      expect(manager.isRunning).toBe(true)
      await manager.close()
      expect(mockWin.destroy).toHaveBeenCalled()
      expect(manager.isRunning).toBe(false)
    })

    it('emits status with running=false', async () => {
      await manager.navigate('https://example.com')
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

  describe('isRunning', () => {
    it('returns true after navigate', async () => {
      await manager.navigate('https://example.com')
      expect(manager.isRunning).toBe(true)
    })

    it('returns false after close', async () => {
      await manager.navigate('https://example.com')
      await manager.close()
      expect(manager.isRunning).toBe(false)
    })
  })

  describe('currentUrl', () => {
    it('returns null when not running', () => {
      expect(manager.currentUrl).toBe(null)
    })

    it('returns the URL from webContents after navigate', async () => {
      await manager.navigate('https://example.com')
      expect(manager.currentUrl).toBe('https://example.com')
    })
  })
})
