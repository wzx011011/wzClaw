import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MultiEditTool } from './multi-edit.js'

describe('MultiEditTool', () => {
  let tool: MultiEditTool
  let tempDir: string
  let filePath: string

  beforeEach(async () => {
    tool = new MultiEditTool()
    tempDir = await mkdtemp(join(tmpdir(), 'multi-test-'))
    filePath = join(tempDir, 'test.txt')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('applies multiple edits in sequence', async () => {
    await writeFile(filePath, 'foo bar baz')
    const result = await tool.execute(
      { path: filePath, edits: [
        { oldString: 'foo', newString: 'one' },
        { oldString: 'baz', newString: 'three' },
      ] },
      { workingDirectory: tempDir, projectRoots: [tempDir] },
    )
    expect(result.isError).toBe(false)
    const content = await readFile(filePath, 'utf-8')
    expect(content).toBe('one bar three')
  })

  it('errors when one edit has ambiguous match', async () => {
    await writeFile(filePath, 'aaa aaa bbb')
    const result = await tool.execute(
      { path: filePath, edits: [
        { oldString: 'bbb', newString: 'ccc' },
        { oldString: 'aaa', newString: 'ddd' },
      ] },
      { workingDirectory: tempDir, projectRoots: [tempDir] },
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('多处匹配')
  })

  it('errors when oldString not found', async () => {
    await writeFile(filePath, 'hello')
    const result = await tool.execute(
      { path: filePath, edits: [
        { oldString: 'xyz', newString: 'abc' },
      ] },
      { workingDirectory: tempDir, projectRoots: [tempDir] },
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('未找到')
  })

  it('requires edits array', async () => {
    const result = await tool.execute(
      { path: filePath } as Record<string, unknown>,
      { workingDirectory: tempDir, projectRoots: [tempDir] },
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('edits')
  })

  it('validates each edit has oldString and newString', async () => {
    const result = await tool.execute(
      { path: filePath, edits: [{ oldString: 'a' }] } as Record<string, unknown>,
      { workingDirectory: tempDir, projectRoots: [tempDir] },
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('newString')
  })
})
