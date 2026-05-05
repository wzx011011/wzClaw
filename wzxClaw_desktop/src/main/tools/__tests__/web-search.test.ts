import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WebSearchTool } from '../web-search'

describe('WebSearchTool', () => {
  let tool: WebSearchTool

  beforeEach(() => {
    tool = new WebSearchTool()
  })

  it('has correct name, description, and requiresApproval', () => {
    expect(tool.name).toBe('WebSearch')
    expect(tool.description).toContain('Search the web')
    expect(tool.requiresApproval).toBe(false)
  })

  it('has inputSchema with query required', () => {
    const schema = tool.inputSchema as { required: string[]; properties: Record<string, unknown> }
    expect(schema.required).toContain('query')
    expect(schema.properties).toHaveProperty('query')
    expect(schema.properties).toHaveProperty('maxResults')
    expect(schema.properties).toHaveProperty('allowed_domains')
    expect(schema.properties).toHaveProperty('blocked_domains')
  })

  it('returns error for empty query', async () => {
    const result = await tool.execute({ query: '' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Invalid input')
  })

  it('returns error for missing query', async () => {
    const result = await tool.execute({}, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Invalid input')
  })

  it('returns results from SearXNG JSON API', async () => {
    const mockJson = {
      results: [
        { title: 'TypeScript: Documentation', url: 'https://www.typescriptlang.org/docs', content: 'TypeScript is a strongly typed programming language.' },
        { title: 'microsoft/TypeScript', url: 'https://github.com/microsoft/TypeScript', content: 'TypeScript is a superset of JavaScript.' }
      ]
    }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockJson)
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute({ query: 'typescript' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('TypeScript: Documentation')
    expect(result.output).toContain('typescriptlang.org')
    expect(result.output).toContain('microsoft/TypeScript')
    expect(result.output).toContain('github.com')
    // 验证调用了 SearXNG 端点
    expect(mockFetch).toHaveBeenCalledOnce()
    expect(mockFetch.mock.calls[0][0]).toContain('searxng.5945.top')
    expect(mockFetch.mock.calls[0][0]).toContain('format=json')
  })

  it('returns no-results message when SearXNG returns empty results', async () => {
    const mockJson = { results: [] }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockJson)
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute({ query: 'zzzznonexistent' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('No results found')
  })

  it('returns error on fetch failure', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error'
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute({ query: 'test' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('500')
  })

  it('returns error on network failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute({ query: 'test' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Network error')
  })

  it('filters by allowed_domains', async () => {
    const mockJson = {
      results: [
        { title: 'GitHub Result', url: 'https://github.com/test', content: 'from github' },
        { title: 'Other Result', url: 'https://other.com/test', content: 'from other' }
      ]
    }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockJson)
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute(
      { query: 'test', allowed_domains: ['github.com'] },
      { workingDirectory: '/tmp' }
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('GitHub Result')
    expect(result.output).not.toContain('Other Result')
  })

  it('filters by blocked_domains', async () => {
    const mockJson = {
      results: [
        { title: 'Pinterest Junk', url: 'https://pinterest.com/pin/123', content: 'junk' },
        { title: 'Good Result', url: 'https://example.com/page', content: 'useful' }
      ]
    }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockJson)
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute(
      { query: 'test', blocked_domains: ['pinterest.com'] },
      { workingDirectory: '/tmp' }
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Good Result')
    expect(result.output).not.toContain('Pinterest')
  })
})
