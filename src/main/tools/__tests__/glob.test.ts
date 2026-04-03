import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GlobTool } from '../glob'
import { MAX_TOOL_RESULT_CHARS } from '../../../shared/constants'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('GlobTool', () => {
  let tool: GlobTool
  const defaultContext = { workingDirectory: '/test/project' }
  let tempDir: string

  beforeEach(() => {
    tool = new GlobTool()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
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

  it('finds matching files with * pattern', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), '')
    fs.writeFileSync(path.join(tempDir, 'b.ts'), '')
    fs.writeFileSync(path.join(tempDir, 'c.js'), '')

    const result = await tool.execute(
      { pattern: '*.ts', path: tempDir },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('a.ts')
    expect(result.output).toContain('b.ts')
    expect(result.output).not.toContain('c.js')
  })

  it('returns empty string on no matches', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.ts'), '')
    fs.writeFileSync(path.join(tempDir, 'b.ts'), '')

    const result = await tool.execute(
      { pattern: '*.py', path: tempDir },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toBe('')
  })

  it('handles nested directories with ** pattern', async () => {
    const srcDir = path.join(tempDir, 'src')
    const utilsDir = path.join(srcDir, 'utils')
    fs.mkdirSync(utilsDir, { recursive: true })
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{}')
    fs.writeFileSync(path.join(srcDir, 'index.ts'), '')
    fs.writeFileSync(path.join(utilsDir, 'helper.ts'), '')

    const result = await tool.execute(
      { pattern: '**/*.ts', path: tempDir },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('index.ts')
    expect(result.output).toContain('helper.ts')
    expect(result.output).not.toContain('package.json')
  })

  it('defaults path to workingDirectory when not provided', async () => {
    const result = await tool.execute({ pattern: '*.ts' }, defaultContext)
    expect(result.isError).toBe(false)
    // /test/project doesn't exist, so empty result
    expect(result.output).toBe('')
  })

  it('rejects invalid input (missing pattern)', async () => {
    const result = await tool.execute({}, defaultContext)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('pattern')
  })

  it('truncates output at MAX_TOOL_RESULT_CHARS', async () => {
    // Create many files
    for (let i = 0; i < 5000; i++) {
      fs.writeFileSync(path.join(tempDir, `file${i}.ts`), '')
    }

    const result = await tool.execute(
      { pattern: '*.ts', path: tempDir },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS)
  })

  it('skips node_modules and hidden directories', async () => {
    const nmDir = path.join(tempDir, 'node_modules')
    const hiddenDir = path.join(tempDir, '.hidden')
    fs.mkdirSync(nmDir)
    fs.mkdirSync(hiddenDir)
    fs.writeFileSync(path.join(nmDir, 'pkg.ts'), '')
    fs.writeFileSync(path.join(hiddenDir, 'secret.ts'), '')
    fs.writeFileSync(path.join(tempDir, 'visible.ts'), '')

    const result = await tool.execute(
      { pattern: '**/*.ts', path: tempDir },
      defaultContext
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('visible.ts')
    expect(result.output).not.toContain('pkg.ts')
    expect(result.output).not.toContain('secret.ts')
  })
})
