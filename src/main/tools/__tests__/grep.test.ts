import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GrepTool } from '../grep'
import { MAX_TOOL_RESULT_CHARS } from '../../../shared/constants'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('GrepTool', () => {
  let tool: GrepTool
  const defaultContext = { workingDirectory: '/test/project' }
  let tempDir: string

  beforeEach(() => {
    tool = new GrepTool()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
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
    fs.writeFileSync(path.join(tempDir, 'test.ts'), 'const x = 1\nconst y = 2\nconsole.log(x)')

    const result = await tool.execute(
      { pattern: 'const', path: tempDir },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('test.ts')
    expect(result.output).toContain('const')
  })

  it('returns empty string on no matches', async () => {
    fs.writeFileSync(path.join(tempDir, 'test.ts'), 'no match here')

    const result = await tool.execute(
      { pattern: 'xyznonexistent', path: tempDir },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toBe('')
  })

  it('returns error for invalid regex pattern', async () => {
    const result = await tool.execute(
      { pattern: '[invalid', path: tempDir },
      defaultContext
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('regex')
  })

  it('truncates output at MAX_TOOL_RESULT_CHARS', async () => {
    // Create a file with many matching lines
    const longLine = 'x'.repeat(1000) + ' MATCH'
    const content = Array.from({ length: 100 }, () => longLine).join('\n')
    fs.writeFileSync(path.join(tempDir, 'big.ts'), content)

    const result = await tool.execute(
      { pattern: 'MATCH', path: tempDir },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS)
  })

  it('defaults path to workingDirectory when not provided', async () => {
    const result = await tool.execute({ pattern: 'test' }, defaultContext)
    expect(result.isError).toBe(false)
    // No files to match in /test/project (non-existent), should return empty
    expect(result.output).toBe('')
  })

  it('rejects invalid input (missing pattern)', async () => {
    const result = await tool.execute({}, defaultContext)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('pattern')
  })

  it('handles nested directories', async () => {
    const subDir = path.join(tempDir, 'subdir')
    fs.mkdirSync(subDir)
    fs.writeFileSync(path.join(tempDir, 'root.ts'), 'const x = 1')
    fs.writeFileSync(path.join(subDir, 'nested.ts'), 'const y = 2')

    const result = await tool.execute(
      { pattern: 'const', path: tempDir },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('root.ts')
    expect(result.output).toContain('nested.ts')
  })

  it('respects include filter', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'const x = 1')
    fs.writeFileSync(path.join(tempDir, 'b.js'), 'const y = 2')

    const result = await tool.execute(
      { pattern: 'const', path: tempDir, include: '*.ts' },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('a.ts')
    expect(result.output).not.toContain('b.js')
  })

  it('skips node_modules and hidden directories', async () => {
    const nmDir = path.join(tempDir, 'node_modules')
    const hiddenDir = path.join(tempDir, '.hidden')
    fs.mkdirSync(nmDir)
    fs.mkdirSync(hiddenDir)
    fs.writeFileSync(path.join(nmDir, 'pkg.ts'), 'const a = 1')
    fs.writeFileSync(path.join(hiddenDir, 'secret.ts'), 'const b = 2')
    fs.writeFileSync(path.join(tempDir, 'visible.ts'), 'const c = 3')

    const result = await tool.execute(
      { pattern: 'const', path: tempDir },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('visible.ts')
    expect(result.output).not.toContain('pkg.ts')
    expect(result.output).not.toContain('secret.ts')
  })
})
