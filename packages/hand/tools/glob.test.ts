import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GlobTool } from './glob.js'

describe('GlobTool', () => {
  let tool: GlobTool
  let tempDir: string

  beforeEach(async () => {
    tool = new GlobTool()
    tempDir = await mkdtemp(join(tmpdir(), 'glob-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('finds files by extension pattern', async () => {
    await writeFile(join(tempDir, 'a.ts'), '')
    await writeFile(join(tempDir, 'b.ts'), '')
    await writeFile(join(tempDir, 'c.js'), '')

    const result = await tool.execute({ pattern: '**/*.ts', path: tempDir }, { workingDirectory: tempDir, projectRoots: [tempDir] })
    expect(result.isError).toBe(false)
    const files = JSON.parse(result.output)
    expect(files).toHaveLength(2)
    expect(files.some((f: string) => f.endsWith('a.ts'))).toBe(true)
  })

  it('finds files in subdirectories with **', async () => {
    const sub = join(tempDir, 'sub')
    await mkdir(sub)
    await writeFile(join(sub, 'deep.ts'), '')

    const result = await tool.execute({ pattern: '**/*.ts', path: tempDir }, { workingDirectory: tempDir, projectRoots: [tempDir] })
    expect(result.isError).toBe(false)
    const files = JSON.parse(result.output)
    expect(files.some((f: string) => f.endsWith('deep.ts'))).toBe(true)
  })

  it('returns no files when nothing matches', async () => {
    await writeFile(join(tempDir, 'a.txt'), '')
    const result = await tool.execute({ pattern: '**/*.rs', path: tempDir }, { workingDirectory: tempDir, projectRoots: [tempDir] })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('No files matched')
  })

  it('requires pattern parameter', async () => {
    const result = await tool.execute({ path: tempDir } as Record<string, unknown>, { workingDirectory: tempDir, projectRoots: [tempDir] })
    expect(result.isError).toBe(true)
  })

  it('skips node_modules and hidden dirs', async () => {
    await mkdir(join(tempDir, 'node_modules'))
    await writeFile(join(tempDir, 'node_modules', 'x.ts'), '')
    await writeFile(join(tempDir, 'visible.ts'), '')

    const result = await tool.execute({ pattern: '**/*.ts', path: tempDir }, { workingDirectory: tempDir, projectRoots: [tempDir] })
    expect(result.isError).toBe(false)
    const files = JSON.parse(result.output)
    expect(files.every((f: string) => !f.includes('node_modules'))).toBe(true)
  })
})
