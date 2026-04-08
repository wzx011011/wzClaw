import { chromium, type Browser, type Page, type BrowserContext } from 'playwright-core'
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

/**
 * BrowserManager — manages a Playwright Chromium browser instance.
 * Provides navigation, DOM interaction, JS evaluation, and auto-screenshots.
 * Emits 'screenshot' and 'status' events for the renderer.
 */
export class BrowserManager extends EventEmitter {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null

  get isRunning(): boolean {
    return this.browser !== null && this.page !== null
  }

  get currentUrl(): string | null {
    return this.page?.url() ?? null
  }

  /**
   * Launch a headless Chromium browser.
   * Uses system-installed Chrome/Chromium or downloads one via playwright.
   */
  async launch(): Promise<void> {
    if (this.browser) return

    // Try to find system Chromium paths
    const executablePath = this.findChromium()

    this.browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {})
    })
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 }
    })
    this.page = await this.context.newPage()
    this.emitStatus()
  }

  async navigate(url: string): Promise<string> {
    await this.ensurePage()
    await this.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const title = await this.page!.title()
    await this.autoScreenshot()
    return title
  }

  async click(selector: string): Promise<void> {
    await this.ensurePage()
    await this.page!.click(selector, { timeout: 10000 })
    // Wait for potential navigation/re-render
    await this.page!.waitForTimeout(500)
    await this.autoScreenshot()
  }

  async type(selector: string, text: string): Promise<void> {
    await this.ensurePage()
    await this.page!.fill(selector, text, { timeout: 10000 })
    await this.autoScreenshot()
  }

  async screenshot(): Promise<string> {
    await this.ensurePage()
    const buffer = await this.page!.screenshot({ type: 'png' })
    const base64 = buffer.toString('base64')
    this.emit('screenshot', {
      url: this.page!.url(),
      base64,
      timestamp: Date.now()
    } satisfies BrowserScreenshot)
    return base64
  }

  async evaluate(javascript: string): Promise<string> {
    await this.ensurePage()
    const result = await this.page!.evaluate(javascript)
    await this.autoScreenshot()
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {})
      this.context = null
    }
    if (this.browser) {
      await this.browser.close().catch(() => {})
      this.browser = null
    }
    this.page = null
    this.emitStatus()
  }

  private async ensurePage(): Promise<void> {
    if (!this.page) {
      await this.launch()
    }
  }

  private async autoScreenshot(): Promise<void> {
    if (!this.page) return
    try {
      const buffer = await this.page.screenshot({ type: 'png' })
      const base64 = buffer.toString('base64')
      this.emit('screenshot', {
        url: this.page.url(),
        base64,
        timestamp: Date.now()
      } satisfies BrowserScreenshot)
    } catch {
      // Screenshot may fail if page is navigating — ignore
    }
  }

  private emitStatus(): void {
    this.emit('status', {
      running: this.isRunning,
      url: this.currentUrl
    } satisfies BrowserStatus)
  }

  private findChromium(): string | undefined {
    // Common Chromium/Chrome paths on Windows
    const paths = [
      process.env.CHROME_PATH,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`
    ]
    const fs = require('fs')
    for (const p of paths) {
      if (p && fs.existsSync(p)) return p
    }
    return undefined
  }
}
