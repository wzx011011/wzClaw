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

  it('returns results from DDG API', async () => {
    const mockData = {
      AbstractText: 'TypeScript overview',
      AbstractURL: 'https://example.com/ts',
      RelatedTopics: [
        { Text: 'TypeScript is a language', FirstURL: 'https://example.com/ts1' },
        { Text: 'TypeScript handbook', FirstURL: 'https://example.com/ts2' }
      ]
    }

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockData)
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute({ query: 'typescript' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('TypeScript overview')
    expect(result.output).toContain('https://example.com/ts')
    expect(result.output).toContain('TypeScript is a language')
  })

  it('returns no-results message when DDG returns empty', async () => {
    const mockData = { RelatedTopics: [] }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockData)
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
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('server error')
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
})
