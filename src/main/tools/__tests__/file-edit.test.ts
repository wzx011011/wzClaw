import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FileEditTool } from '../file-edit'

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined)
  }
}))

import fs from 'fs/promises'

describe('FileEditTool', () => {
  let tool: FileEditTool

  beforeEach(() => {
    tool = new FileEditTool()
    vi.clearAllMocks()
  })

  it('has correct metadata', () => {
    expect(tool.name).toBe('FileEdit')
    expect(tool.requiresApproval).toBe(true)
    expect(tool.description).toContain('replacing')
    expect(tool.inputSchema).toBeDefined()
  })

  it('replaces exact single match with new_string', async () => {
    const original = 'function hello() {\n  return "world"\n}'
    vi.mocked(fs.readFile).mockResolvedValue(original)

    const result = await tool.execute(
      {
        path: '/project/file.ts',
        old_string: 'return "world"',
        new_string: 'return "hello"'
      },
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Edited')
    expect(result.output).toContain('file.ts')
    expect(result.output).toContain('chars')

    const writtenContent = vi.mocked(fs.writeFile).mock.calls[0][1] as string
    expect(writtenContent).toBe('function hello() {\n  return "hello"\n}')
  })

  it('returns error when old_string not found in file', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('const x = 1')

    const result = await tool.execute(
      {
        path: '/project/file.ts',
        old_string: 'not present',
        new_string: 'replacement'
      },
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('not found')
    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('returns error when old_string matches multiple times', async () => {
    const content = 'const a = "hello"\nconst b = "hello"'
    vi.mocked(fs.readFile).mockResolvedValue(content)

    const result = await tool.execute(
      {
        path: '/project/file.ts',
        old_string: '"hello"',
        new_string: '"world"'
      },
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('matches')
    expect(result.output).toContain('2')
    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('returns error for empty old_string', async () => {
    const result = await tool.execute(
      {
        path: '/project/file.ts',
        old_string: '',
        new_string: 'replacement'
      },
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('old_string')
  })

  it('returns error for empty path', async () => {
    const result = await tool.execute(
      {
        path: '',
        old_string: 'text',
        new_string: 'replacement'
      },
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('path')
  })

  it('returns error when file read fails', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT: file not found'))

    const result = await tool.execute(
      {
        path: '/project/missing.ts',
        old_string: 'something',
        new_string: 'else'
      },
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('file not found')
  })

  it('reports old/new char lengths in output', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('short')

    const result = await tool.execute(
      {
        path: '/project/file.ts',
        old_string: 'short',
        new_string: 'much longer replacement'
      },
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('5')
    expect(result.output).toContain('23')
  })
})
