import { BrowserWindow } from 'electron'
import { EventEmitter } from 'events'

export interface BrowserScreenshot {
  url: string
  base64: string
  timestamp: number
}

export interface BrowserStatus {
  running: boolean
  url: string | null
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes auto-close

/**
 * BrowserManager — manages an Electron BrowserWindow instance.
 * Provides navigation, DOM interaction, JS evaluation, and auto-screenshots.
 * Emits 'screenshot' and 'status' events for the renderer.
 * The window is created lazily on first use and auto-closed after 5 minutes idle.
 */
export class BrowserManager extends EventEmitter {
  private win: BrowserWindow | null = null
  private idleTimer: NodeJS.Timeout | null = null

  private ensureWin(): BrowserWindow {
    if (!this.win || this.win.isDestroyed()) {
      this.win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        }
      })
      this.win.on('closed', () => { this.win = null })
      this.emit('status', { running: true, url: null } satisfies BrowserStatus)
    }
    return this.win
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.close(), IDLE_TIMEOUT_MS)
  }

  async navigate(url: string): Promise<string> {
    const win = this.ensureWin()
    await win.loadURL(url)
    const title = win.webContents.getTitle()
    await this.autoScreenshot(win)
    this.resetIdleTimer()
    return title
  }

  async click(selector: string): Promise<void> {
    const win = this.ensureWin()
    await win.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)})?.click()`
    )
    await new Promise<void>(r => setTimeout(r, 500))
    await this.autoScreenshot(win)
    this.resetIdleTimer()
  }

  async type(selector: string, text: string): Promise<void> {
    const win = this.ensureWin()
    await win.webContents.executeJavaScript(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `)
    await this.autoScreenshot(win)
    this.resetIdleTimer()
  }

  async screenshot(): Promise<string> {
    const win = this.ensureWin()
    return this.captureBase64(win)
  }

  async evaluate(javascript: string): Promise<string> {
    const win = this.ensureWin()
    const result = await win.webContents.executeJavaScript(javascript)
    await this.autoScreenshot(win)
    this.resetIdleTimer()
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  }

  async close(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy()
      this.win = null
    }
    this.emit('status', { running: false, url: null } satisfies BrowserStatus)
  }

  get isRunning(): boolean {
    return !!(this.win && !this.win.isDestroyed())
  }

  get currentUrl(): string | null {
    if (!this.isRunning) return null
    return this.win!.webContents.getURL() || null
  }

  private async captureBase64(win: BrowserWindow): Promise<string> {
    const image = await win.webContents.capturePage()
    return image.toPNG().toString('base64')
  }

  private async autoScreenshot(win: BrowserWindow): Promise<void> {
    try {
      const base64 = await this.captureBase64(win)
      const url = win.webContents.getURL()
      this.emit('screenshot', { url, base64, timestamp: Date.now() } satisfies BrowserScreenshot)
      this.emit('status', { running: true, url } satisfies BrowserStatus)
    } catch {
      // ignore screenshot failures (page may still be loading)
    }
  }
}
