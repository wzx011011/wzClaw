// ============================================================
// SemanticSearchTool Tests
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SemanticSearchTool } from '../semantic-search'

// Mock IndexingEngine
const createMockIndexingEngine = () => ({
  search: vi.fn().mockResolvedValue([
    {
      filePath: 'src/index.ts',
      startLine: 10,
      endLine: 25,
      content: 'function authenticate(user: User): boolean {\n  return verify(user.token)\n}',
      score: 0.95
    },
    {
      filePath: 'src/auth/handler.ts',
      startLine: 5,
      endLine: 12,
      content: 'export class AuthHandler {\n  handle(req: Request) {\n    return this.authenticate(req)\n  }\n}',
      score: 0.78
    }
  ]),
  getStatus: vi.fn().mockReturnValue({ status: 'ready', fileCount: 42, currentFile: '' })
})

describe('SemanticSearchTool', () => {
  let tool: SemanticSearchTool
  let mockEngine: ReturnType<typeof createMockIndexingEngine>

  beforeEach(() => {
    tool = new SemanticSearchTool()
    mockEngine = createMockIndexingEngine()
  })

  it('has correct metadata', () => {
    expect(tool.name).toBe('SemanticSearch')
    expect(tool.requiresApproval).toBe(false)
    expect(tool.inputSchema.type).toBe('object')
    expect(tool.inputSchema.required).toContain('query')
  })

  it('returns error when no IndexingEngine is set', async () => {
    const result = await tool.execute({ query: 'auth function' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not available')
    expect(result.output).toContain('workspace')
  })

  it('returns search results when IndexingEngine is available', async () => {
    tool.setIndexingEngine(mockEngine as any)
    const result = await tool.execute({ query: 'authentication logic' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('2 results')
    expect(result.output).toContain('src/index.ts:10-25')
    expect(result.output).toContain('src/auth/handler.ts:5-12')
    expect(result.output).toContain('0.950')
    expect(result.output).toContain('0.780')
  })

  it('validates query is required', async () => {
    const result = await tool.execute({}, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Invalid input')
  })

  it('validates query is non-empty string', async () => {
    const result = await tool.execute({ query: '' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Invalid input')
  })

  it('accepts optional topK parameter', async () => {
    tool.setIndexingEngine(mockEngine as any)
    await tool.execute({ query: 'test', topK: 5 }, { workingDirectory: '/tmp' })
    expect(mockEngine.search).toHaveBeenCalledWith('test', 5)
  })

  it('defaults topK to 10 when not provided', async () => {
    tool.setIndexingEngine(mockEngine as any)
    await tool.execute({ query: 'test' }, { workingDirectory: '/tmp' })
    expect(mockEngine.search).toHaveBeenCalledWith('test', 10)
  })

  it('returns helpful message for zero results', async () => {
    mockEngine.search.mockResolvedValueOnce([])
    tool.setIndexingEngine(mockEngine as any)
    const result = await tool.execute({ query: 'nonexistent xyz' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('No results found')
    expect(result.output).toContain('Grep')
  })

  it('handles search errors gracefully', async () => {
    mockEngine.search.mockRejectedValueOnce(new Error('Index not loaded'))
    tool.setIndexingEngine(mockEngine as any)
    const result = await tool.execute({ query: 'test' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Semantic search failed')
    expect(result.output).toContain('Index not loaded')
  })

  it('truncates output at MAX_TOOL_RESULT_CHARS', async () => {
    // Create many large results
    const largeResults = Array.from({ length: 50 }, (_, i) => ({
      filePath: `src/file${i}.ts`,
      startLine: 1,
      endLine: 100,
      content: 'x'.repeat(1000),
      score: 0.9 - i * 0.01
    }))
    mockEngine.search.mockResolvedValueOnce(largeResults)
    tool.setIndexingEngine(mockEngine as any)

    const result = await tool.execute({ query: 'test' }, { workingDirectory: '/tmp' })
    expect(result.isError).toBe(false)
    expect(result.output.length).toBeLessThanOrEqual(30000 + 80) // MAX_TOOL_RESULT_CHARS + truncation notice
    expect(result.output).toContain('truncated')
  })
})
