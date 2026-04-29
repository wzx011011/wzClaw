import { describe, it, expect, vi } from 'vitest'
import { WebFetchTool } from '../web-fetch'

describe('WebFetchTool', () => {
  let tool: WebFetchTool

  beforeAll(() => {
    tool = new WebFetchTool()
  })

  it('has correct name, description, and requiresApproval', () => {
    expect(tool.name).toBe('WebFetch')
    expect(tool.description).toContain('Markdown')
    expect(tool.requiresApproval).toBe(false)
  })

  it('has inputSchema with url required', () => {
    const schema = tool.inputSchema as { required: string[]; properties: Record<string, unknown> }
    expect(schema.required).toContain('url')
    expect(schema.properties).toHaveProperty('url')
    expect(schema.properties).toHaveProperty('maxLength')
    expect(schema.properties).toHaveProperty('prompt')
  })

  it('rejects non-http URLs', async () => {
    const result = await tool.execute({ url: 'ftp://example.com' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('http://')
  })

  it('rejects missing URL', async () => {
    const result = await tool.execute({}, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Invalid input')
  })

  it('converts HTML to Markdown', async () => {
    const html = `<html><body><h1>Title</h1><p>Hello &amp; World</p><ul><li>item1</li><li>item2</li></ul></body></html>`
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/html' },
      text: () => Promise.resolve(html)
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute(
      { url: 'https://example.com' },
      { workingDirectory: '/tmp' }
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Hello & World')
    expect(result.output).not.toContain('<p>')
    // turndown 转换后应保留 Markdown 结构
    expect(result.output).toContain('# Title')
  })

  it('truncates content at max length', async () => {
    const longContent = '<p>' + 'A'.repeat(20000) + '</p>'
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/html' },
      text: () => Promise.resolve(longContent)
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute(
      { url: 'https://example.com/long-page', maxLength: 1000 },
      { workingDirectory: '/tmp' }
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('content truncated')
    expect(result.output.length).toBeLessThan(1200)
  })

  it('prepends source URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/html' },
      text: () => Promise.resolve('<p>Some content</p>')
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute(
      { url: 'https://example.com/page' },
      { workingDirectory: '/tmp' }
    )
    expect(result.isError).toBe(false)
    expect(result.output).toMatch(/^Source: https:\/\/example\.com\/page/)
  })

  it('includes prompt in output when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/html' },
      text: () => Promise.resolve('<p>Installation instructions here</p>')
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute(
      { url: 'https://example.com', prompt: 'Extract installation steps' },
      { workingDirectory: '/tmp' }
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Focus: Extract installation steps')
  })

  it('rejects binary content types', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/pdf' },
      text: () => Promise.resolve('binary data')
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute(
      { url: 'https://example.com/binary-file.pdf' },
      { workingDirectory: '/tmp' }
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('binary content')
  })

  it('returns error on non-200 status', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve('page not found')
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute(
      { url: 'https://example.com/missing' },
      { workingDirectory: '/tmp' }
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('404')
  })

  it('returns error on network failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'))
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute(
      { url: 'https://example.com/fail-network' },
      { workingDirectory: '/tmp' }
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Connection refused')
  })
})
