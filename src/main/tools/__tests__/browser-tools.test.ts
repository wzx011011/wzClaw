import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserScreenshotTool,
  BrowserEvaluateTool,
  BrowserCloseTool
} from '../browser-tools'
import type { BrowserManager } from '../../browser/browser-manager'

function createMockManager(): BrowserManager {
  return {
    navigate: vi.fn().mockResolvedValue('Test Page'),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue('base64data'),
    evaluate: vi.fn().mockResolvedValue('eval result'),
    close: vi.fn().mockResolvedValue(undefined),
    currentUrl: 'https://example.com',
    isRunning: true
  } as unknown as BrowserManager
}

describe('BrowserNavigateTool', () => {
  let tool: BrowserNavigateTool
  let mgr: BrowserManager

  beforeEach(() => {
    mgr = createMockManager()
    tool = new BrowserNavigateTool(mgr)
  })

  it('has correct metadata', () => {
    expect(tool.name).toBe('BrowserNavigate')
    expect(tool.requiresApproval).toBe(false)
    expect(tool.inputSchema.required).toContain('url')
  })

  it('navigates and returns title', async () => {
    const result = await tool.execute({ url: 'https://example.com' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Test Page')
    expect(mgr.navigate).toHaveBeenCalledWith('https://example.com')
  })

  it('returns error when url missing', async () => {
    const result = await tool.execute({})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('url is required')
  })

  it('returns error on navigation failure', async () => {
    ;(mgr.navigate as any).mockRejectedValue(new Error('timeout'))
    const result = await tool.execute({ url: 'https://bad.com' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('timeout')
  })
})

describe('BrowserClickTool', () => {
  let tool: BrowserClickTool
  let mgr: BrowserManager

  beforeEach(() => {
    mgr = createMockManager()
    tool = new BrowserClickTool(mgr)
  })

  it('has correct metadata', () => {
    expect(tool.name).toBe('BrowserClick')
    expect(tool.inputSchema.required).toContain('selector')
  })

  it('clicks and returns success', async () => {
    const result = await tool.execute({ selector: '#btn' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('#btn')
    expect(mgr.click).toHaveBeenCalledWith('#btn')
  })

  it('returns error when selector missing', async () => {
    const result = await tool.execute({})
    expect(result.isError).toBe(true)
  })

  it('returns error on click failure', async () => {
    ;(mgr.click as any).mockRejectedValue(new Error('not found'))
    const result = await tool.execute({ selector: '#nope' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not found')
  })
})

describe('BrowserTypeTool', () => {
  let tool: BrowserTypeTool
  let mgr: BrowserManager

  beforeEach(() => {
    mgr = createMockManager()
    tool = new BrowserTypeTool(mgr)
  })

  it('has correct metadata', () => {
    expect(tool.name).toBe('BrowserType')
    expect(tool.inputSchema.required).toContain('selector')
    expect(tool.inputSchema.required).toContain('text')
  })

  it('types text and returns success', async () => {
    const result = await tool.execute({ selector: '#input', text: 'hello' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('hello')
    expect(mgr.type).toHaveBeenCalledWith('#input', 'hello')
  })

  it('returns error when params missing', async () => {
    const result = await tool.execute({ selector: '#input' })
    expect(result.isError).toBe(true)
  })

  it('returns error on type failure', async () => {
    ;(mgr.type as any).mockRejectedValue(new Error('element detached'))
    const result = await tool.execute({ selector: '#x', text: 'a' })
    expect(result.isError).toBe(true)
  })
})

describe('BrowserScreenshotTool', () => {
  let tool: BrowserScreenshotTool
  let mgr: BrowserManager

  beforeEach(() => {
    mgr = createMockManager()
    tool = new BrowserScreenshotTool(mgr)
  })

  it('has correct metadata', () => {
    expect(tool.name).toBe('BrowserScreenshot')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.requiresApproval).toBe(false)
  })

  it('captures screenshot and returns success', async () => {
    const result = await tool.execute({})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('example.com')
    expect(mgr.screenshot).toHaveBeenCalled()
  })

  it('returns error on failure', async () => {
    ;(mgr.screenshot as any).mockRejectedValue(new Error('no page'))
    const result = await tool.execute({})
    expect(result.isError).toBe(true)
  })
})

describe('BrowserEvaluateTool', () => {
  let tool: BrowserEvaluateTool
  let mgr: BrowserManager

  beforeEach(() => {
    mgr = createMockManager()
    tool = new BrowserEvaluateTool(mgr)
  })

  it('has correct metadata', () => {
    expect(tool.name).toBe('BrowserEvaluate')
    expect(tool.requiresApproval).toBe(true)
    expect(tool.inputSchema.required).toContain('javascript')
  })

  it('evaluates JS and returns result', async () => {
    const result = await tool.execute({ javascript: 'document.title' })
    expect(result.isError).toBe(false)
    expect(result.output).toBe('eval result')
  })

  it('returns error when javascript missing', async () => {
    const result = await tool.execute({})
    expect(result.isError).toBe(true)
  })

  it('returns error on evaluation failure', async () => {
    ;(mgr.evaluate as any).mockRejectedValue(new Error('syntax error'))
    const result = await tool.execute({ javascript: 'bad(' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('syntax error')
  })
})

describe('BrowserCloseTool', () => {
  let tool: BrowserCloseTool
  let mgr: BrowserManager

  beforeEach(() => {
    mgr = createMockManager()
    tool = new BrowserCloseTool(mgr)
  })

  it('has correct metadata', () => {
    expect(tool.name).toBe('BrowserClose')
    expect(tool.requiresApproval).toBe(false)
  })

  it('closes browser', async () => {
    const result = await tool.execute({})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Browser closed')
    expect(mgr.close).toHaveBeenCalled()
  })

  it('returns error on close failure', async () => {
    ;(mgr.close as any).mockRejectedValue(new Error('already closed'))
    const result = await tool.execute({})
    expect(result.isError).toBe(true)
  })
})
