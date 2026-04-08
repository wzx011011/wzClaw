import type { Tool, ToolExecutionContext, ToolExecutionResult } from './tool-interface'
import type { BrowserManager } from '../browser/browser-manager'

/**
 * BrowserNavigate — navigate the browser to a URL.
 * Automatically launches the browser if not running.
 */
export class BrowserNavigateTool implements Tool {
  readonly name = 'BrowserNavigate'
  readonly description =
    'Navigate the browser to a URL. Launches a headless Chromium browser if not already running. Returns the page title. A screenshot is automatically captured after navigation.'
  readonly requiresApproval = false
  readonly isReadOnly = false
  readonly inputSchema = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to navigate to (must include protocol, e.g. https://)' }
    },
    required: ['url']
  }

  constructor(private browserManager: BrowserManager) {}

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const url = input.url as string
    if (!url) return { output: 'Error: url is required', isError: true }
    try {
      const title = await this.browserManager.navigate(url)
      return { output: `Navigated to ${url}\nPage title: ${title}`, isError: false }
    } catch (err: any) {
      return { output: `Navigation failed: ${err.message}`, isError: true }
    }
  }
}

/**
 * BrowserClick — click an element using a CSS selector.
 */
export class BrowserClickTool implements Tool {
  readonly name = 'BrowserClick'
  readonly description =
    'Click an element on the current page using a CSS selector. A screenshot is captured after the click.'
  readonly requiresApproval = false
  readonly isReadOnly = false
  readonly inputSchema = {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector of the element to click' }
    },
    required: ['selector']
  }

  constructor(private browserManager: BrowserManager) {}

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const selector = input.selector as string
    if (!selector) return { output: 'Error: selector is required', isError: true }
    try {
      await this.browserManager.click(selector)
      return { output: `Clicked element: ${selector}`, isError: false }
    } catch (err: any) {
      return { output: `Click failed: ${err.message}`, isError: true }
    }
  }
}

/**
 * BrowserType — type text into an input field using a CSS selector.
 */
export class BrowserTypeTool implements Tool {
  readonly name = 'BrowserType'
  readonly description =
    'Type text into an input element on the current page using a CSS selector. Replaces existing content.'
  readonly requiresApproval = false
  readonly isReadOnly = false
  readonly inputSchema = {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector of the input element' },
      text: { type: 'string', description: 'The text to type into the element' }
    },
    required: ['selector', 'text']
  }

  constructor(private browserManager: BrowserManager) {}

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const selector = input.selector as string
    const text = input.text as string
    if (!selector || text === undefined) return { output: 'Error: selector and text are required', isError: true }
    try {
      await this.browserManager.type(selector, text)
      return { output: `Typed "${text}" into ${selector}`, isError: false }
    } catch (err: any) {
      return { output: `Type failed: ${err.message}`, isError: true }
    }
  }
}

/**
 * BrowserScreenshot — capture a screenshot of the current page.
 */
export class BrowserScreenshotTool implements Tool {
  readonly name = 'BrowserScreenshot'
  readonly description =
    'Capture a PNG screenshot of the current browser page. Returns a confirmation message. The screenshot is automatically pushed to the preview panel.'
  readonly requiresApproval = false
  readonly isReadOnly = true
  readonly inputSchema = {
    type: 'object',
    properties: {},
    required: []
  }

  constructor(private browserManager: BrowserManager) {}

  async execute(): Promise<ToolExecutionResult> {
    try {
      await this.browserManager.screenshot()
      const url = this.browserManager.currentUrl ?? 'unknown'
      return { output: `Screenshot captured for ${url}`, isError: false }
    } catch (err: any) {
      return { output: `Screenshot failed: ${err.message}`, isError: true }
    }
  }
}

/**
 * BrowserEvaluate — execute JavaScript in the browser context.
 */
export class BrowserEvaluateTool implements Tool {
  readonly name = 'BrowserEvaluate'
  readonly description =
    'Execute JavaScript code in the browser page context and return the result. Useful for extracting data, manipulating the DOM, or testing page behavior.'
  readonly requiresApproval = true
  readonly isReadOnly = false
  readonly inputSchema = {
    type: 'object',
    properties: {
      javascript: { type: 'string', description: 'JavaScript code to execute in the page context' }
    },
    required: ['javascript']
  }

  constructor(private browserManager: BrowserManager) {}

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const javascript = input.javascript as string
    if (!javascript) return { output: 'Error: javascript is required', isError: true }
    try {
      const result = await this.browserManager.evaluate(javascript)
      return { output: result, isError: false }
    } catch (err: any) {
      return { output: `Evaluate failed: ${err.message}`, isError: true }
    }
  }
}

/**
 * BrowserClose — close the browser instance.
 */
export class BrowserCloseTool implements Tool {
  readonly name = 'BrowserClose'
  readonly description = 'Close the browser instance and free resources.'
  readonly requiresApproval = false
  readonly isReadOnly = false
  readonly inputSchema = {
    type: 'object',
    properties: {},
    required: []
  }

  constructor(private browserManager: BrowserManager) {}

  async execute(): Promise<ToolExecutionResult> {
    try {
      await this.browserManager.close()
      return { output: 'Browser closed', isError: false }
    } catch (err: any) {
      return { output: `Close failed: ${err.message}`, isError: true }
    }
  }
}
