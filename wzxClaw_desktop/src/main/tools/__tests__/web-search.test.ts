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

  it('returns results parsed from DDG HTML', async () => {
    const mockHtml = `
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs">TypeScript: Documentation</a>
          <a class="result__snippet">TypeScript is a strongly typed programming language that builds on JavaScript.</a>
        </div>
      </div>
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fgithub.com%2Fmicrosoft%2FTypeScript">microsoft/TypeScript</a>
          <a class="result__snippet">TypeScript is a superset of JavaScript that compiles to clean JavaScript output.</a>
        </div>
      </div>
    `
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml)
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await tool.execute({ query: 'typescript' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('TypeScript: Documentation')
    expect(result.output).toContain('typescriptlang.org')
    expect(result.output).toContain('microsoft/TypeScript')
    expect(result.output).toContain('github.com')
  })

  it('returns no-results message when DDG HTML has no results', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><body>No results</body></html>')
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
