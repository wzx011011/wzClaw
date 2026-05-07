import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FileReadTool } from '../file-read'
import { MAX_FILE_READ_LINES, MAX_FILE_READ_BYTES } from '../../../shared/constants'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('FileReadTool', () => {
  let tool: FileReadTool
  const defaultContext = { workingDirectory: '/test/project' }
  let tempDir: string

  beforeEach(() => {
    tool = new FileReadTool()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileread-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
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
    const filePath = path.join(tempDir, 'test.txt')
    fs.writeFileSync(filePath, 'line1\nline2\nline3')

    const result = await tool.execute({ path: filePath }, { workingDirectory: tempDir })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('1\tline1')
    expect(result.output).toContain('2\tline2')
    expect(result.output).toContain('3\tline3')
  })

  it('returns error for non-existent file', async () => {
    const result = await tool.execute(
      { path: path.join(tempDir, 'missing.txt') },
      { workingDirectory: tempDir }
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('File not found')
    expect(result.output).toContain('missing.txt')
  })

  it('respects offset parameter', async () => {
    const filePath = path.join(tempDir, 'test.txt')
    fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5')

    const result = await tool.execute({ path: filePath, offset: 2 }, { workingDirectory: tempDir })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('3\tline3')
    expect(result.output).not.toContain('1\tline1')
    expect(result.output).not.toContain('2\tline2')
  })

  it('respects limit parameter', async () => {
    const filePath = path.join(tempDir, 'test.txt')
    fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5')

    const result = await tool.execute({ path: filePath, limit: 2 }, { workingDirectory: tempDir })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('1\tline1')
    expect(result.output).toContain('2\tline2')
    expect(result.output).not.toContain('3\tline3')
  })

  it('truncates output at MAX_FILE_READ_LINES lines', async () => {
    const filePath = path.join(tempDir, 'big.txt')
    const lines = Array.from({ length: 3000 }, (_, i) => `line${i + 1}`)
    fs.writeFileSync(filePath, lines.join('\n'))

    const result = await tool.execute({ path: filePath }, { workingDirectory: tempDir })
    expect(result.isError).toBe(false)
    const outputLines = result.output.split('\n').filter((l) => l.length > 0)
    expect(outputLines.length).toBeLessThanOrEqual(MAX_FILE_READ_LINES)
  })

  it('does not truncate files under 1 MB (no generic truncation — handled upstream)', async () => {
    const filePath = path.join(tempDir, 'long.txt')
    // 50000 chars 远低于 1MB，FileRead 应原样返回全部内容
    const longLine = 'x'.repeat(50000)
    fs.writeFileSync(filePath, longLine + '\n')

    const result = await tool.execute({ path: filePath }, { workingDirectory: tempDir })
    expect(result.isError).toBe(false)
    // FileRead 设置 maxResultSizeChars = Infinity，不做通用截断
    expect(result.output.length).toBeGreaterThan(50000)
  })

  it('rejects files larger than MAX_FILE_READ_BYTES with a helpful message', async () => {
    const filePath = path.join(tempDir, 'huge.txt')
    // 写入略超过 1MB 的文件
    const chunk = Buffer.alloc(MAX_FILE_READ_BYTES + 1024, 'a')
    fs.writeFileSync(filePath, chunk)

    const result = await tool.execute({ path: filePath }, { workingDirectory: tempDir })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('File too large')
    expect(result.output).toContain('offset')
    expect(result.output).toContain('limit')
  })

  it('handles relative paths resolved against workingDirectory', async () => {
    const filePath = path.join(tempDir, 'test.txt')
    fs.writeFileSync(filePath, 'hello world')

    const result = await tool.execute(
      { path: 'test.txt' },
      { workingDirectory: tempDir }
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('hello world')
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
