import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FileReadTool } from '../file-read'
import { MAX_FILE_READ_LINES, MAX_TOOL_RESULT_CHARS } from '../../../shared/constants'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('fs', () => ({
  readFile: vi.fn(),
  existsSync: vi.fn()
}))

describe('FileReadTool', () => {
  let tool: FileReadTool
  const defaultContext = { workingDirectory: '/test/project' }

  beforeEach(() => {
    tool = new FileReadTool()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('has correct name and description', () => {
    expect(tool.name).toBe('FileRead')
    expect(tool.description).toContain('file')
    expect(tool.requiresApproval).toBe(false)
  })

  it('has inputSchema with path required and optional offset/limit', () => {
    const schema = tool.inputSchema
    expect(schema.properties).toBeDefined()
    expect(schema.properties.path).toBeDefined()
    expect(schema.required).toContain('path')
  })

  it('reads an existing file and returns content with line numbers', async () => {
    const content = 'line1\nline2\nline3'
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFile as any).mockImplementation((_p: string, _e: string, cb: Function) => {
      cb(null, content)
    })

    const result = await tool.execute({ path: '/test/project/test.txt' }, defaultContext)
    expect(result.isError).toBe(false)
    expect(result.output).toContain('1\tline1')
    expect(result.output).toContain('2\tline2')
    expect(result.output).toContain('3\tline3')
  })

  it('returns error for non-existent file', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const result = await tool.execute({ path: '/test/project/missing.txt' }, defaultContext)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('File not found')
    expect(result.output).toContain('missing.txt')
  })

  it('respects offset parameter', async () => {
    const content = 'line1\nline2\nline3\nline4\nline5'
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFile as any).mockImplementation((_p: string, _e: string, cb: Function) => {
      cb(null, content)
    })

    const result = await tool.execute(
      { path: '/test/project/test.txt', offset: 2 },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('3\tline3')
    expect(result.output).not.toContain('1\tline1')
    expect(result.output).not.toContain('2\tline2')
  })

  it('respects limit parameter', async () => {
    const content = 'line1\nline2\nline3\nline4\nline5'
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFile as any).mockImplementation((_p: string, _e: string, cb: Function) => {
      cb(null, content)
    })

    const result = await tool.execute(
      { path: '/test/project/test.txt', limit: 2 },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('1\tline1')
    expect(result.output).toContain('2\tline2')
    expect(result.output).not.toContain('3\tline3')
  })

  it('truncates output at MAX_FILE_READ_LINES lines', async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line${i + 1}`)
    const content = lines.join('\n')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFile as any).mockImplementation((_p: string, _e: string, cb: Function) => {
      cb(null, content)
    })

    const result = await tool.execute({ path: '/test/project/big.txt' }, defaultContext)
    expect(result.isError).toBe(false)
    const outputLines = result.output.split('\n').filter((l) => l.length > 0)
    expect(outputLines.length).toBeLessThanOrEqual(MAX_FILE_READ_LINES)
  })

  it('truncates output at MAX_TOOL_RESULT_CHARS characters', async () => {
    const longLine = 'x'.repeat(50000)
    const content = longLine + '\n'
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFile as any).mockImplementation((_p: string, _e: string, cb: Function) => {
      cb(null, content)
    })

    const result = await tool.execute({ path: '/test/project/long.txt' }, defaultContext)
    expect(result.isError).toBe(false)
    expect(result.output.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS)
  })

  it('handles fs.readFile errors gracefully', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFile as any).mockImplementation((_p: string, _e: string, cb: Function) => {
      cb(new Error('Permission denied'))
    })

    const result = await tool.execute({ path: '/test/project/test.txt' }, defaultContext)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Permission denied')
  })

  it('rejects invalid input (missing path)', async () => {
    const result = await tool.execute({}, defaultContext)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('path')
  })

  it('rejects invalid input (wrong type for path)', async () => {
    const result = await tool.execute({ path: 123 }, defaultContext)
    expect(result.isError).toBe(true)
  })
})
