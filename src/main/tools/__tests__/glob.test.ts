import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GlobTool } from '../glob'
import { MAX_TOOL_RESULT_CHARS } from '../../../shared/constants'
import * as fs from 'fs'

vi.mock('fs', () => ({
  readdirSync: vi.fn(),
  statSync: vi.fn()
}))

describe('GlobTool', () => {
  let tool: GlobTool
  const defaultContext = { workingDirectory: '/test/project' }

  beforeEach(() => {
    tool = new GlobTool()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('has correct name and description', () => {
    expect(tool.name).toBe('Glob')
    expect(tool.description).toContain('glob')
    expect(tool.requiresApproval).toBe(false)
  })

  it('has inputSchema with pattern required', () => {
    const schema = tool.inputSchema
    expect(schema.properties).toBeDefined()
    expect(schema.properties.pattern).toBeDefined()
    expect(schema.required).toContain('pattern')
  })

  it('finds matching files', async () => {
    vi.mocked(fs.readdirSync).mockReturnValueOnce(['a.ts', 'b.ts', 'c.js'] as any)
    vi.mocked(fs.statSync)
      .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true } as any)
      .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true } as any)
      .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true } as any)

    const result = await tool.execute(
      { pattern: '*.ts', path: '/test/project' },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('a.ts')
    expect(result.output).toContain('b.ts')
    expect(result.output).not.toContain('c.js')
  })

  it('returns empty string on no matches', async () => {
    vi.mocked(fs.readdirSync).mockReturnValueOnce(['a.ts', 'b.ts'] as any)
    vi.mocked(fs.statSync)
      .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true } as any)
      .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true } as any)

    const result = await tool.execute(
      { pattern: '*.py', path: '/test/project' },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toBe('')
  })

  it('handles nested directories with ** pattern', async () => {
    vi.mocked(fs.readdirSync)
      .mockReturnValueOnce(['src', 'package.json'] as any) // root
      .mockReturnValueOnce(['utils', 'index.ts'] as any) // src
      .mockReturnValueOnce(['helper.ts'] as any) // src/utils
    vi.mocked(fs.statSync)
      .mockReturnValueOnce({ isDirectory: () => true, isFile: () => false } as any) // src
      .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true } as any) // package.json
      .mockReturnValueOnce({ isDirectory: () => true, isFile: () => false } as any) // src/utils
      .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true } as any) // src/index.ts
      .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true } as any) // src/utils/helper.ts

    const result = await tool.execute(
      { pattern: '**/*.ts', path: '/test/project' },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('index.ts')
    expect(result.output).toContain('helper.ts')
  })

  it('defaults path to workingDirectory when not provided', async () => {
    vi.mocked(fs.readdirSync).mockReturnValueOnce([] as any)

    const result = await tool.execute({ pattern: '*.ts' }, defaultContext)
    expect(result.isError).toBe(false)
    expect(result.output).toBe('')
  })

  it('rejects invalid input (missing pattern)', async () => {
    const result = await tool.execute({}, defaultContext)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('pattern')
  })

  it('truncates output at MAX_TOOL_RESULT_CHARS', async () => {
    // Create many file entries
    const files = Array.from({ length: 5000 }, (_, i) => `file${i}.ts`)
    vi.mocked(fs.readdirSync).mockReturnValueOnce(files as any)
    files.forEach(() => {
      vi.mocked(fs.statSync).mockReturnValueOnce({ isDirectory: () => false, isFile: () => true } as any)
    })

    const result = await tool.execute(
      { pattern: '*.ts', path: '/test/project' },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS)
  })
})
