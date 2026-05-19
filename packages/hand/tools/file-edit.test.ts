import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileEditTool } from './file-edit.js'

describe('FileEditTool', () => {
  let tool: FileEditTool
  let tempDir: string
  let filePath: string

  beforeEach(async () => {
    tool = new FileEditTool()
    tempDir = await mkdtemp(join(tmpdir(), 'edit-test-'))
    filePath = join(tempDir, 'test.txt')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('replaces first occurrence by default', async () => {
    await writeFile(filePath, 'hello world\nfoo bar')
    const result = await tool.execute(
      { path: filePath, oldString: 'hello', newString: 'hi' },
      { workingDirectory: tempDir, projectRoots: [tempDir] },
    )
    expect(result.isError).toBe(false)
    const content = await readFile(filePath, 'utf-8')
    expect(content).toBe('hi world\nfoo bar')
  })

  it('replaceAll replaces all occurrences', async () => {
    await writeFile(filePath, 'aaa bbb aaa')
    const result = await tool.execute(
      { path: filePath, oldString: 'aaa', newString: 'ccc', replaceAll: true },
      { workingDirectory: tempDir, projectRoots: [tempDir] },
    )
    expect(result.isError).toBe(false)
    const content = await readFile(filePath, 'utf-8')
    expect(content).toBe('ccc bbb ccc')
  })

  it('errors when oldString not found', async () => {
    await writeFile(filePath, 'hello')
    const result = await tool.execute(
      { path: filePath, oldString: 'xyz', newString: 'abc' },
      { workingDirectory: tempDir, projectRoots: [tempDir] },
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('未找到')
  })

  it('errors on ambiguous match without replaceAll', async () => {
    await writeFile(filePath, 'aaa bbb aaa')
    const result = await tool.execute(
      { path: filePath, oldString: 'aaa', newString: 'ccc' },
      { workingDirectory: tempDir, projectRoots: [tempDir] },
    )
    expect(result.isError).toBe(true)
    expect(result.output).toContain('多处匹配')
  })

  it('errors when oldString equals newString', async () => {
    const result = await tool.execute(
      { path: filePath, oldString: 'same', newString: 'same' },
      { workingDirectory: tempDir, projectRoots: [tempDir] },
    )
    expect(result.isError).toBe(true)
  })

  it('requires path parameter', async () => {
    const result = await tool.execute(
      { oldString: 'a', newString: 'b' } as Record<string, unknown>,
      { workingDirectory: tempDir, projectRoots: [tempDir] },
    )
    expect(result.isError).toBe(true)
  })
})
