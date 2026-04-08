import { describe, it, expect, vi } from 'vitest'
import { WebFetchTool } from '../web-fetch'

describe('WebFetchTool', () => {
  let tool: WebFetchTool

  // No beforeEach -- rate limit state is shared, so create once
  // and use long timeout in tests
  beforeAll(() => {
    tool = new WebFetchTool()
  })

  it('has correct name, description, and requiresApproval', () => {
    expect(tool.name).toBe('WebFetch')
    expect(tool.description).toContain('Fetch a web page')
    expect(tool.requiresApproval).toBe(false)
  })

  it('has inputSchema with url required', () => {
    const schema = tool.inputSchema as { required: string[]; properties: Record<string, unknown> }
    expect(schema.required).toContain('url')
    expect(schema.properties).toHaveProperty('url')
    expect(schema.properties).toHaveProperty('maxLength')
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

  it('strips HTML tags and decodes entities', async () => {
    const html = `<html><head><style>body{color:red}</style></head><body><p>Hello &amp; World</p><script>alert('x')</script></body></html>`
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
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
    expect(result.output).not.toContain('<script>')
    expect(result.output).not.toContain('alert')
  })

  it('truncates content at max length', async () => {
    const longContent = '<p>' + 'A'.repeat(20000) + '</p>'
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(longContent)
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute(
      { url: 'https://example.com', maxLength: 1000 },
      { workingDirectory: '/tmp' }
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('content truncated')
    expect(result.output.length).toBeLessThan(1200)
  })

  it('prepends source URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
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
      { url: 'https://example.com' },
      { workingDirectory: '/tmp' }
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Connection refused')
  })
})
