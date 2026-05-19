import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GrepTool } from './grep.js'

describe('GrepTool', () => {
  let tool: GrepTool
  let tempDir: string

  beforeEach(async () => {
    tool = new GrepTool()
    tempDir = await mkdtemp(join(tmpdir(), 'grep-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('finds matching lines', async () => {
    await writeFile(join(tempDir, 'a.txt'), 'hello world\nfoo bar\nhello again')
    const result = await tool.execute({ pattern: 'hello', path: tempDir }, { workingDirectory: tempDir, projectRoots: [tempDir] })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('hello world')
    expect(result.output).toContain('hello again')
  })

  it('supports regex pattern', async () => {
    await writeFile(join(tempDir, 'b.ts'), 'const x = 1\nconst y = 2\nlet z = 3')
    const result = await tool.execute({ pattern: '^const', path: tempDir }, { workingDirectory: tempDir, projectRoots: [tempDir] })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('const x')
    expect(result.output).toContain('const y')
    expect(result.output).not.toContain('let z')
  })

  it('supports ignoreCase', async () => {
    await writeFile(join(tempDir, 'c.txt'), 'Hello World')
    const result = await tool.execute({ pattern: 'hello', path: tempDir, ignoreCase: true }, { workingDirectory: tempDir, projectRoots: [tempDir] })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Hello World')
  })

  it('returns no matches message when nothing found', async () => {
    await writeFile(join(tempDir, 'd.txt'), 'nothing here')
    const result = await tool.execute({ pattern: 'xyz', path: tempDir }, { workingDirectory: tempDir, projectRoots: [tempDir] })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('No matches')
  })

  it('requires pattern parameter', async () => {
    const result = await tool.execute({ path: tempDir } as Record<string, unknown>, { workingDirectory: tempDir, projectRoots: [tempDir] })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('pattern')
  })

  it('skips node_modules and hidden dirs', async () => {
    await mkdir(join(tempDir, 'node_modules'))
    await writeFile(join(tempDir, 'node_modules', 'nm.txt'), 'hidden match')
    await mkdir(join(tempDir, '.hidden'))
    await writeFile(join(tempDir, '.hidden', 'h.txt'), 'hidden match')
    await writeFile(join(tempDir, 'visible.txt'), 'visible match')

    const result = await tool.execute({ pattern: 'match', path: tempDir }, { workingDirectory: tempDir, projectRoots: [tempDir] })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('visible match')
    expect(result.output).not.toContain('hidden')
  })

  it('filters by type', async () => {
    await writeFile(join(tempDir, 'a.ts'), 'match this')
    await writeFile(join(tempDir, 'b.js'), 'match this too')

    const result = await tool.execute({ pattern: 'match', path: tempDir, type: 'ts' }, { workingDirectory: tempDir, projectRoots: [tempDir] })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('a.ts')
    expect(result.output).not.toContain('b.js')
  })
})
