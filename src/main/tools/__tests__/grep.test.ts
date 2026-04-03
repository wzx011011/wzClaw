import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GrepTool } from '../grep'
import { MAX_TOOL_RESULT_CHARS } from '../../../shared/constants'
import * as fs from 'fs'

vi.mock('fs', () => ({
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn()
}))

describe('GrepTool', () => {
  let tool: GrepTool
  const defaultContext = { workingDirectory: '/test/project' }

  beforeEach(() => {
    tool = new GrepTool()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('has correct name and description', () => {
    expect(tool.name).toBe('Grep')
    expect(tool.description).toContain('regex')
    expect(tool.requiresApproval).toBe(false)
  })

  it('has inputSchema with pattern required', () => {
    const schema = tool.inputSchema
    expect(schema.properties).toBeDefined()
    expect(schema.properties.pattern).toBeDefined()
    expect(schema.required).toContain('pattern')
  })

  it('finds matching lines in files', async () => {
    // Mock a directory with one file
    vi.mocked(fs.readdirSync)
      .mockReturnValueOnce(['test.ts'] as any) // first call: list directory
    vi.mocked(fs.statSync)
      .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true } as any)
    vi.mocked(fs.readFileSync as any).mockReturnValue('const x = 1\nconst y = 2\nconsole.log(x)')

    const result = await tool.execute(
      { pattern: 'const', path: '/test/project' },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('test.ts')
    expect(result.output).toContain('const')
  })

  it('returns empty string on no matches', async () => {
    vi.mocked(fs.readdirSync).mockReturnValueOnce(['test.ts'] as any)
    vi.mocked(fs.statSync)
      .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true } as any)
    vi.mocked(fs.readFileSync as any).mockReturnValue('no match here')

    const result = await tool.execute(
      { pattern: 'xyznonexistent', path: '/test/project' },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toBe('')
  })

  it('returns error for invalid regex pattern', async () => {
    const result = await tool.execute(
      { pattern: '[invalid', path: '/test/project' },
      defaultContext
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('regex')
  })

  it('truncates output at MAX_TOOL_RESULT_CHARS', async () => {
    // Create a scenario with many matching lines
    const longLine = 'x'.repeat(1000) + ' MATCH'
    const fileContent = Array.from({ length: 100 }, () => longLine).join('\n')

    vi.mocked(fs.readdirSync).mockReturnValueOnce(['big.ts'] as any)
    vi.mocked(fs.statSync)
      .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true } as any)
    vi.mocked(fs.readFileSync as any).mockReturnValue(fileContent)

    const result = await tool.execute(
      { pattern: 'MATCH', path: '/test/project' },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS)
  })

  it('defaults path to workingDirectory when not provided', async () => {
    vi.mocked(fs.readdirSync).mockReturnValueOnce([] as any)

    const result = await tool.execute({ pattern: 'test' }, defaultContext)
    expect(result.isError).toBe(false)
    expect(result.output).toBe('')
  })

  it('rejects invalid input (missing pattern)', async () => {
    const result = await tool.execute({}, defaultContext)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('pattern')
  })

  it('handles nested directories', async () => {
    // Root has subdir and a file
    vi.mocked(fs.readdirSync)
      .mockReturnValueOnce(['subdir', 'root.ts'] as any) // root listing
      .mockReturnValueOnce(['nested.ts'] as any) // subdir listing
    vi.mocked(fs.statSync)
      .mockReturnValueOnce({ isDirectory: () => true, isFile: () => false } as any) // subdir
      .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true } as any) // root.ts
      .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true } as any) // nested.ts
    vi.mocked(fs.readFileSync as any)
      .mockReturnValueOnce('const x = 1') // root.ts
      .mockReturnValueOnce('const y = 2') // nested.ts

    const result = await tool.execute(
      { pattern: 'const', path: '/test/project' },
      defaultContext
    )
    expect(result.isError).toBe(false)
    // Both files should appear in output
    expect(result.output).toContain('root.ts')
    expect(result.output).toContain('nested.ts')
  })
})
