import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FileWriteTool } from '../file-write'

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('path', () => ({
  default: {
    resolve: vi.fn((base: string, p: string) => `${base}/${p}`),
    dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/'))
  }
}))

import fs from 'fs/promises'

describe('FileWriteTool', () => {
  let tool: FileWriteTool

  beforeEach(() => {
    tool = new FileWriteTool()
    vi.clearAllMocks()
  })

  it('has correct metadata', () => {
    expect(tool.name).toBe('FileWrite')
    expect(tool.requiresApproval).toBe(true)
    expect(tool.description).toContain('file')
    expect(tool.inputSchema).toBeDefined()
  })

  it('writes content to a new file and creates parent directories', async () => {
    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.writeFile).mockResolvedValue(undefined)

    const result = await tool.execute(
      { path: '/project/src/new-file.ts', content: 'hello world' },
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('/project/src/new-file.ts')
    expect(result.output).toContain('bytes')
    expect(fs.mkdir).toHaveBeenCalledWith(
      expect.stringContaining('src'),
      { recursive: true }
    )
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('new-file.ts'),
      'hello world',
      'utf-8'
    )
  })

  it('overwrites an existing file', async () => {
    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.writeFile).mockResolvedValue(undefined)

    const result = await tool.execute(
      { path: '/project/existing.ts', content: 'new content' },
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('existing.ts')
  })

  it('returns error for empty path', async () => {
    const result = await tool.execute(
      { path: '', content: 'content' },
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('path')
  })

  it('returns error for missing path', async () => {
    const result = await tool.execute(
      { content: 'content' },
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('path')
  })

  it('returns error when fs.writeFile fails', async () => {
    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.writeFile).mockRejectedValue(new Error('Permission denied'))

    const result = await tool.execute(
      { path: '/project/file.ts', content: 'content' },
      { workingDirectory: '/project' }
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('Permission denied')
  })
})
